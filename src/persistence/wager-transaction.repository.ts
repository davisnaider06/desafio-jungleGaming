import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../shared/money';
import { FailureCode } from '../wagering/domain/failure-codes';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/domain/wager-transaction';
import { WagerTransactionRecord } from './records';

@Injectable()
export class WagerTransactionRepository {
  async findById(
    em: EntityManager,
    id: string,
  ): Promise<WagerTransaction | null> {
    return this.one(em, { id });
  }

  async findByIdempotencyKey(
    em: EntityManager,
    key: string,
  ): Promise<WagerTransaction | null> {
    return this.one(em, { idempotencyKey: key });
  }

  async findByProviderExternal(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.one(em, { providerId, externalTransactionId });
  }

  /** Já existe REFUND/ROLLBACK apontando para esta transação? (o índice único parcial é a garantia final) */
  async isReversed(em: EntityManager, referenceId: string): Promise<boolean> {
    const count = await em.count(WagerTransactionRecord, {
      referenceTransactionId: referenceId,
      kind: {
        $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
      },
    });
    return count > 0;
  }

  async insert(em: EntityManager, tx: WagerTransaction): Promise<void> {
    await em.insert(WagerTransactionRecord, {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      ...mutableFields(tx),
      createdAt: tx.createdAt,
    });
  }

  /** Atualiza só os campos que mudam nas transições (o banco proíbe mudar uma transação terminal). */
  async update(em: EntityManager, tx: WagerTransaction): Promise<void> {
    await em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      mutableFields(tx),
    );
  }

  /**
   * Pega transações PENDING_REFERENCE já vencidas e TRAVA as linhas com SKIP LOCKED:
   * várias instâncias podem rodar o worker ao mesmo tempo sem pegar a mesma linha.
   */
  async lockDuePendingReference(
    em: EntityManager,
    now: Date,
    limit: number,
  ): Promise<WagerTransaction[]> {
    const rows = await em.getConnection().execute<{ id: string }[]>(
      `select id from wager_transactions
          where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
          order by next_attempt_at
          limit ?
          for update skip locked`,
      [now, limit],
    );
    const result: WagerTransaction[] = [];
    for (const row of rows) {
      const tx = await this.findById(em, row.id);
      if (tx) result.push(tx);
    }
    return result;
  }

  private async one(em: EntityManager, where: Partial<WagerTransactionRecord>) {
    const record = await em.findOne(WagerTransactionRecord, where, {
      refresh: true,
    });
    return record ? toDomain(record) : null;
  }
}

function mutableFields(tx: WagerTransaction) {
  return {
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceSnapshot: tx.balanceSnapshot?.amount ?? null,
    pendingAttempts: tx.pendingAttempts,
    nextAttemptAt: tx.nextAttemptAt ?? null,
    processedAt: tx.processedAt ?? null,
  };
}

function toDomain(record: WagerTransactionRecord): WagerTransaction {
  const currency = record.currency;
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.fromStored({ amount: record.amount, currency }),
    referenceExternalTransactionId:
      record.referenceExternalTransactionId ?? undefined,
    createdAt: new Date(record.createdAt),
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ? new Date(record.processedAt) : undefined,
    balanceSnapshot: record.balanceSnapshot
      ? Money.fromStored({ amount: record.balanceSnapshot, currency })
      : undefined,
    pendingAttempts: record.pendingAttempts,
    nextAttemptAt: record.nextAttemptAt
      ? new Date(record.nextAttemptAt)
      : undefined,
  });
}

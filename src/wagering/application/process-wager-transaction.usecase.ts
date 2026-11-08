import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { Database } from '../../persistence/database.service';
import { LedgerRepository } from '../../persistence/ledger.repository';
import { WagerTransactionRepository } from '../../persistence/wager-transaction.repository';
import { WalletRepository } from '../../persistence/wallet.repository';
import { IdempotencyConflictError } from '../../shared/errors';
import type { MoneyProps } from '../../shared/money';
import { FailureCode } from '../domain/failure-codes';
import { processWager } from '../domain/wager-processor';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { nextPendingDelayMs } from './pending-policy';
import {
  hashPayload,
  parseWagerPayload,
  validateIdempotencyKey,
} from './wager-payload';

export interface WagerSubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo da wallet no momento da decisão (igual em todos os replays). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface SubmitWagerInput {
  idempotencyKey: unknown;
  payload: unknown;
  correlationId?: string;
}

export function toResult(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): WagerSubmitResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.balanceSnapshot?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

/**
 * Caso de uso ÚNICO para processar uma transação, usado tanto pelo HTTP quanto pelo
 * consumidor SQS. Não existe segundo caminho com regras diferentes.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(LedgerRepository) private readonly ledger: LedgerRepository,
    @Inject(WagerTransactionRepository)
    private readonly txs: WagerTransactionRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(input: SubmitWagerInput): Promise<WagerSubmitResult> {
    const key = validateIdempotencyKey(input.idempotencyKey);
    const parsed = parseWagerPayload(input.payload);
    const hash = hashPayload(parsed);

    // Se duas requisições com a mesma chave disputarem um INSERT, o banco recusa uma delas
    // (unique em idempotency_key). Basta tentar de novo: agora a transação já existe e vira replay.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(key, parsed, hash);
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException && attempt < 3)
          continue;
        throw error;
      }
    }
  }

  private async attempt(
    key: string,
    parsed: ReturnType<typeof parseWagerPayload>,
    hash: string,
  ): Promise<WagerSubmitResult> {
    // Caminho rápido: repetição de algo já decidido não precisa de lock nenhum.
    const known = await this.db.read((em) =>
      this.txs.findByIdempotencyKey(em, key),
    );
    if (known) return this.replay(known, hash);

    return this.db.transaction(async (em) => {
      // LOCK por wallet. Todas as operações da mesma wallet passam por esta linha, uma de cada vez;
      // o resto das wallets segue em paralelo. Sem isso, "ler saldo -> calcular -> gravar" perderia atualizações.
      const wallet = await this.wallets.findByIdForUpdate(em, parsed.walletId);

      // IDEMPOTÊNCIA: checa de novo DEPOIS do lock. Quem esperou o lock enxerga o commit de quem passou antes,
      // então 50 requisições iguais em paralelo geram 1 débito e 49 replays.
      const existing = await this.txs.findByIdempotencyKey(em, key);
      if (existing) return this.replay(existing, hash);

      const sameExternal = await this.txs.findByProviderExternal(
        em,
        parsed.providerId,
        parsed.externalTransactionId,
      );
      if (sameExternal) {
        throw new IdempotencyConflictError(
          `transaction ${parsed.providerId}/${parsed.externalTransactionId} already exists under another Idempotency-Key`,
        );
      }

      const now = new Date();
      const tx = WagerTransaction.create({
        ...parsed,
        id: randomUUID(),
        idempotencyKey: key,
        payloadHash: hash,
        createdAt: now,
      });

      const reference = parsed.referenceExternalTransactionId
        ? await this.txs.findByProviderExternal(
            em,
            parsed.providerId,
            parsed.referenceExternalTransactionId,
          )
        : null;
      const referenceAlreadyReversed =
        reference && tx.isReversal()
          ? await this.txs.isReversed(em, reference.id)
          : false;

      const versionBefore = wallet?.version ?? 0;
      const entry = processWager({
        tx,
        wallet,
        reference,
        referenceAlreadyReversed,
        now,
        newEntryId: randomUUID,
        nextAttemptAt: new Date(
          now.getTime() + nextPendingDelayMs(0, this.config.pendingReference),
        ),
        giveUpWaitingReference: false,
      });

      await this.persist(em, tx, wallet, entry, versionBefore);
      return toResult(tx, false);
    });
  }

  /** Grava tudo na MESMA transação SQL: transação, ledger e saldo. */
  private async persist(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Awaited<ReturnType<WalletRepository['findByIdForUpdate']>>,
    entry: Awaited<ReturnType<typeof processWager>>,
    versionBefore: number,
  ): Promise<void> {
    await this.txs.insert(em, tx);
    if (entry && wallet) {
      await this.ledger.insert(em, entry);
      await this.wallets.saveBalance(em, wallet, versionBefore);
    }
  }

  private replay(existing: WagerTransaction, hash: string): WagerSubmitResult {
    if (!existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError(
        'Idempotency-Key was already used with a different payload',
      );
    }
    return toResult(existing, true);
  }
}

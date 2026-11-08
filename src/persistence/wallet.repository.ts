import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletVersionConflictError } from '../shared/errors';
import { Money } from '../shared/money';
import { Wallet } from '../wallets/domain/wallet';
import { WalletRecord } from './records';

@Injectable()
export class WalletRepository {
  /**
   * Lê a wallet e TRAVA a linha até o fim da transação (SELECT ... FOR UPDATE).
   * É o lock pessimista por wallet: quem chegar depois espera aqui, enquanto
   * wallets diferentes seguem em paralelo (não existe lock global).
   */
  async findByIdForUpdate(
    em: EntityManager,
    id: string,
  ): Promise<Wallet | null> {
    const record = await em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? toDomain(record) : null;
  }

  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id }, { refresh: true });
    return record ? toDomain(record) : null;
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.insert(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }

  /**
   * Grava o novo saldo. O WHERE inclui a versão antiga: se alguém tiver mexido na wallet
   * sem o lock (bug), nenhuma linha é afetada e falhamos em vez de sobrescrever (lost update).
   */
  async saveBalance(
    em: EntityManager,
    wallet: Wallet,
    expectedVersion: number,
  ): Promise<void> {
    const updated = await em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (updated !== 1) {
      throw new WalletVersionConflictError(
        `wallet ${wallet.id} changed concurrently`,
      );
    }
  }
}

function toDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.fromStored({
      amount: record.balance,
      currency: record.currency,
    }),
    version: record.version,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  });
}

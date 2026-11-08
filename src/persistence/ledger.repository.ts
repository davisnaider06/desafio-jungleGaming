import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../shared/money';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../wallets/domain/wallet-ledger-entry';
import { WalletLedgerEntryRecord } from './records';

export interface LedgerSummary {
  /** Soma de créditos menos débitos, calculada pelo banco. */
  calculatedBalance: string;
  entries: number;
}

@Injectable()
export class LedgerRepository {
  /** O ledger só recebe INSERT. Não existe update nem delete (e o trigger do banco proíbe). */
  async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.insert(WalletLedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  }

  /** Extrato paginado por `walletVersion` (crescente). `afterVersion` é o cursor. */
  async list(
    em: EntityManager,
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const records = await em.find(
      WalletLedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit, refresh: true },
    );
    return records.map(toDomain);
  }

  async findByTransactionId(
    em: EntityManager,
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const record = await em.findOne(
      WalletLedgerEntryRecord,
      { transactionId },
      { refresh: true },
    );
    return record ? toDomain(record) : null;
  }
}

function toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  const currency = record.currency;
  const money = (amount: string) => Money.fromStored({ amount, currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    walletVersion: record.walletVersion,
    createdAt: new Date(record.createdAt),
  });
}

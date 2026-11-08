import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { Database } from '../../persistence/database.service';
import { logger } from '../../observability/logger';
import { M, metrics } from '../../observability/metrics';
import { WalletBalanceChanged } from '../../messaging/domain/events';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { LedgerRepository } from '../../persistence/ledger.repository';
import { OutboxRepository } from '../../persistence/outbox.repository';
import { WagerTransactionRepository } from '../../persistence/wager-transaction.repository';
import { WalletRepository } from '../../persistence/wallet.repository';
import { canonicalHash } from '../../shared/canonical-hash';
import {
  InvalidMoneyError,
  InvalidPayloadError,
  NotFoundError,
  WalletAlreadyExistsError,
} from '../../shared/errors';
import { Money, MoneyProps } from '../../shared/money';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { LedgerDirection } from '../domain/wallet-ledger-entry';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const toView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

/** Cursor opaco: base64url de {v: última walletVersion vista}. O cliente não deve interpretar. */
const encodeCursor = (version: number) =>
  Buffer.from(JSON.stringify({ v: version })).toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (Number.isInteger(parsed?.v) && parsed.v >= 0) return parsed.v;
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidPayloadError('invalid cursor');
}

@Injectable()
export class WalletService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(LedgerRepository) private readonly ledger: LedgerRepository,
    @Inject(WagerTransactionRepository)
    private readonly txs: WagerTransactionRepository,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
  ) {}

  async create(body: unknown): Promise<WalletView> {
    if (body === null || typeof body !== 'object') {
      throw new InvalidPayloadError('body must be a JSON object');
    }
    const { playerId, initialBalance } = body as Record<string, unknown>;
    if (
      typeof playerId !== 'string' ||
      playerId.trim() === '' ||
      playerId.length > 64
    ) {
      throw new InvalidPayloadError(
        'playerId must be a non-empty string up to 64 chars',
      );
    }
    let money: Money;
    try {
      money = Money.from(initialBalance as MoneyProps);
    } catch (error) {
      if (error instanceof InvalidMoneyError)
        throw new InvalidPayloadError(error.message);
      throw error;
    }

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance: money,
    });
    const openingTxId = randomUUID();
    const entry = wallet.openingEntry({
      entryId: randomUUID(),
      transactionId: openingTxId,
    });

    try {
      // Wallet + transação OPENING + lançamento CREDIT: tudo ou nada, na mesma transação SQL.
      await this.db.transaction(async (em) => {
        await this.wallets.insert(em, wallet);
        if (entry) {
          await this.txs.insert(
            em,
            WagerTransaction.opening({
              id: openingTxId,
              walletId: wallet.id,
              playerId,
              money,
              payloadHash: canonicalHash({
                walletId: wallet.id,
                playerId,
                money: money.toJSON(),
              }),
              at: wallet.createdAt,
            }),
          );
          await this.ledger.insert(em, entry);
          // Evento na mesma transação (outbox): o saldo inicial também é uma mudança de saldo.
          await this.outbox.insertAll(em, [
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, entry, {
                correlationId: randomUUID(),
              }),
            ),
          ]);
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(
          `player ${playerId} already has a ${money.currency} wallet`,
        );
      }
      throw error;
    }
    return toView(wallet);
  }

  async get(walletId: string): Promise<WalletView> {
    const wallet = await this.db.read((em) =>
      this.wallets.findById(em, walletId),
    );
    if (!wallet) throw new NotFoundError(`wallet ${walletId} not found`);
    return toView(wallet);
  }

  async listLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const after = decodeCursor(cursor);
    return this.db.read(async (em) => {
      if (!(await this.wallets.findById(em, walletId))) {
        throw new NotFoundError(`wallet ${walletId} not found`);
      }
      // Busca um a mais para saber se existe próxima página.
      const rows = await this.ledger.list(em, walletId, after, limit + 1);
      const page = rows.slice(0, limit);
      const items: LedgerEntryView[] = page.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        walletVersion: e.walletVersion,
        createdAt: e.createdAt.toISOString(),
      }));
      const nextCursor =
        rows.length > limit
          ? encodeCursor(page[page.length - 1].walletVersion)
          : null;
      return { items, nextCursor };
    });
  }

  /**
   * Confere o saldo guardado contra a soma do ledger. NÃO corrige nada: só informa.
   * A leitura é um único SELECT, então enxerga um retrato consistente mesmo com tráfego.
   */
  async reconcile(walletId: string): Promise<ReconciliationView> {
    const rows = await this.db.read((em) =>
      em.execute<
        {
          balance: string;
          currency: string;
          calculated: string;
          entries: string;
        }[]
      >(
        `select w.balance, w.currency,
                coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as calculated,
                count(l.id) as entries
           from wallets w
           left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      ),
    );
    const row = rows[0];
    if (!row) throw new NotFoundError(`wallet ${walletId} not found`);

    const currency = row.currency;
    const stored = Money.fromStored({ amount: row.balance, currency });
    const calculated = Money.fromStored({ amount: row.calculated, currency });
    const difference = stored.subtract(calculated);
    if (!difference.isZero()) {
      // Divergência: NUNCA é corrigida aqui. Fica registrada (log + métrica) e sinalizada na resposta
      // para um humano investigar. Corrigir em silêncio esconderia o bug que a causou.
      metrics.inc(M.reconciliationDivergence);
      logger.error('wallet reconciliation divergence', {
        walletId,
        checkedEntries: Number(row.entries),
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: Number(row.entries),
    };
  }
}

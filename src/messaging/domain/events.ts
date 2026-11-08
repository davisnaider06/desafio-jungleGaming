import type { MoneyProps } from '../../shared/money';
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallets/domain/wallet-ledger-entry';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { EventContext, IntegrationEvent } from './integration-event';

/** Campos que identificam a transação em todos os eventos dela. */
interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
}

const transactionData = (tx: WagerTransaction): TransactionData => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

/** Qualquer transação aplicada com sucesso, INCLUSIVE LOSS (que não mexe no saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<
  TransactionData & { balance?: MoneyProps }
> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...transactionData(tx), balance: tx.balanceSnapshot?.toJSON() },
    });
  }
}

/** Rejeitada por regra de negócio (saldo insuficiente, referência inválida, referência que não chegou...). */
export class WagerTransactionRejected extends IntegrationEvent<
  TransactionData & { failureCode: string }
> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...transactionData(tx),
        failureCode: tx.failureCode ?? 'UNKNOWN',
      },
    });
  }
}

/** A referência (BET original etc.) ainda não chegou; a transação espera. */
export class WagerTransactionPendingReference extends IntegrationEvent<
  TransactionData & { referenceExternalTransactionId: string }
> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
      },
    });
  }
}

/** SOMENTE quando o saldo muda (nunca para LOSS nem para rejeições). */
export class WalletBalanceChanged extends IntegrationEvent<{
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}> {
  readonly eventType = 'WalletBalanceChanged' as const;
  readonly version = 1 as const;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

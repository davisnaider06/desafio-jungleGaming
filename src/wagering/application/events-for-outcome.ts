import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../messaging/domain/events';
import type {
  EventContext,
  IntegrationEvent,
} from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

/**
 * Quais eventos nascem de uma decisão sobre a transação:
 *   PROCESSED          -> WagerTransactionProcessed (+ WalletBalanceChanged se o saldo mudou)
 *   REJECTED           -> WagerTransactionRejected
 *   PENDING_REFERENCE  -> WagerTransactionPendingReference (só na PRIMEIRA vez que fica pendente)
 */
export function eventsForOutcome(args: {
  tx: WagerTransaction;
  previousStatus: WagerTransactionStatus;
  wallet: Wallet | null;
  entry?: WalletLedgerEntry;
  ctx: EventContext;
}): OutboxMessage[] {
  const { tx, previousStatus, wallet, entry, ctx } = args;
  const events: IntegrationEvent<object>[] = [];

  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(tx, ctx));
      if (entry && wallet)
        events.push(WalletBalanceChanged.from(wallet, entry, ctx));
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(tx, ctx));
      break;
    case WagerTransactionStatus.PendingReference:
      if (previousStatus === WagerTransactionStatus.Pending) {
        events.push(WagerTransactionPendingReference.from(tx, ctx));
      }
      break;
  }
  return events.map((e) => OutboxMessage.enqueue(e));
}

import { InsufficientFundsError } from '../../shared/errors';
import { Wallet } from '../../wallets/domain/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallets/domain/wallet-ledger-entry';
import { FailureCode } from './failure-codes';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface ProcessWagerContext {
  tx: WagerTransaction;
  /** null quando o walletId não existe. */
  wallet: Wallet | null;
  /** Transação referenciada, já resolvida por (providerId, referenceExternalTransactionId). null se ainda não chegou. */
  reference: WagerTransaction | null;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para a referência? */
  referenceAlreadyReversed: boolean;
  now: Date;
  newEntryId: () => string;
  /** Quando tentar de novo, se ficarmos em PENDING_REFERENCE. */
  nextAttemptAt: Date;
  /** O worker já esperou demais: referência ausente vira REJECTED em vez de PENDING_REFERENCE. */
  giveUpWaitingReference: boolean;
}

/** Quais tipos de transação cada tipo pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Aplica as regras de negócio a UMA transação, mudando `tx` e `wallet` em memória.
 * Devolve o lançamento do ledger quando o saldo mudou (o chamador grava tudo na
 * mesma transação SQL). Não faz I/O: o chamador já deve estar com a wallet travada.
 */
export function processWager(
  ctx: ProcessWagerContext,
): WalletLedgerEntry | undefined {
  const { tx, wallet, now } = ctx;

  if (!wallet) {
    tx.reject(FailureCode.WalletNotFound, now, undefined);
    return undefined;
  }
  const reject = (code: FailureCode) => {
    tx.reject(code, now, wallet.balance);
    return undefined;
  };

  if (wallet.playerId !== tx.playerId)
    return reject(FailureCode.WalletPlayerMismatch);
  if (wallet.currency !== tx.money.currency)
    return reject(FailureCode.CurrencyMismatch);

  // ---- referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS) ----
  let reference: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId) {
    if (!ctx.reference) {
      // Fora de ordem: a referência pode chegar depois. Espera, a menos que o prazo tenha estourado.
      if (ctx.giveUpWaitingReference)
        return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(
        ctx.nextAttemptAt,
        wallet.balance,
        tx.status === WagerTransactionStatus.PendingReference,
      );
      return undefined;
    }
    reference = ctx.reference;

    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      // A própria referência ainda não foi decidida: mesma situação de "ainda não chegou".
      if (ctx.giveUpWaitingReference)
        return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(
        ctx.nextAttemptAt,
        wallet.balance,
        tx.status === WagerTransactionStatus.PendingReference,
      );
      return undefined;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.roundId !== tx.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (reference.money.currency !== tx.money.currency) {
      return reject(FailureCode.CurrencyMismatch);
    }
    if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(reference.kind)) {
      return reject(FailureCode.InvalidReferenceKind);
    }
    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money))
        return reject(FailureCode.AmountMismatch);
      if (ctx.referenceAlreadyReversed)
        return reject(FailureCode.ReferenceAlreadyReversed);
    }
  }

  // ---- efeito no saldo ----
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance);
    return undefined;
  }

  const direction = tx.ledgerDirectionFor(reference);
  const input = {
    entryId: ctx.newEntryId(),
    transactionId: tx.id,
    money: tx.money,
    at: now,
  };
  try {
    const entry =
      direction === LedgerDirection.Debit
        ? wallet.debit(input)
        : wallet.credit(input);
    tx.markProcessed(reference?.id, now, wallet.balance);
    return entry;
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      // Débito de reversão (ROLLBACK de WIN/REFUND) tem código próprio para ficar auditável.
      return reject(
        tx.isReversal()
          ? FailureCode.ReversalWouldOverdraw
          : FailureCode.InsufficientFunds,
      );
    }
    throw error;
  }
}

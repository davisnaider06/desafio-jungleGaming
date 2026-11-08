import { describe, expect, test } from 'bun:test';
import {
  InvalidPayloadError,
  InvalidTransactionStateError,
} from '../../shared/errors';
import { canonicalHash } from '../../shared/canonical-hash';
import { Money } from '../../shared/money';
import { Wallet } from '../../wallets/domain/wallet';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';
import { FailureCode } from './failure-codes';
import { ProcessWagerContext, processWager } from './wager-processor';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const newWallet = (balance = '100.00') =>
  Wallet.open({
    id: id(),
    playerId: 'p1',
    initialBalance: brl(balance),
    now: NOW,
  });

function newTx(
  wallet: Wallet,
  kind: Kind,
  amount: string,
  extra: {
    ref?: string;
    currency?: string;
    playerId?: string;
    roundId?: string;
  } = {},
) {
  const external = `ext-${++seq}`;
  return WagerTransaction.create({
    id: id(),
    providerId: 'prov',
    externalTransactionId: external,
    idempotencyKey: `prov:${external}`,
    payloadHash: canonicalHash({ external }),
    walletId: wallet.id,
    playerId: extra.playerId ?? 'p1',
    roundId: extra.roundId ?? 'r1',
    gameId: 'g1',
    kind,
    money: Money.from({ amount, currency: extra.currency ?? 'BRL' }),
    referenceExternalTransactionId: extra.ref,
    createdAt: NOW,
  });
}

function run(
  wallet: Wallet | null,
  tx: WagerTransaction,
  extra: Partial<ProcessWagerContext> = {},
) {
  const entry = processWager({
    tx,
    wallet,
    reference: null,
    referenceAlreadyReversed: false,
    now: NOW,
    newEntryId: id,
    nextAttemptAt: new Date(NOW.getTime() + 1000),
    giveUpWaitingReference: false,
    ...extra,
  });
  return entry;
}

describe('Wallet', () => {
  test('abre com versão 1 e só sobe a versão quando o saldo muda', () => {
    const w = newWallet('50.00');
    expect(w.version).toBe(1);
    const entry = w.debit({
      entryId: id(),
      transactionId: id(),
      money: brl('20.00'),
      at: NOW,
    });
    expect(w.balance.amount).toBe('30.00');
    expect(w.version).toBe(2);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(2);
  });

  test('saldo nunca fica negativo', () => {
    const w = newWallet('10.00');
    expect(() =>
      w.debit({
        entryId: id(),
        transactionId: id(),
        money: brl('10.01'),
        at: NOW,
      }),
    ).toThrow('is less than');
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('moeda diferente da wallet é erro de domínio', () => {
    const w = newWallet();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() =>
      w.credit({ entryId: id(), transactionId: id(), money: usd, at: NOW }),
    ).toThrow('wallet currency is BRL');
  });

  test('lançamento de abertura existe só com saldo inicial positivo', () => {
    expect(
      newWallet('10.00').openingEntry({ entryId: id(), transactionId: id() }),
    ).toBeDefined();
    expect(
      newWallet('0.00').openingEntry({ entryId: id(), transactionId: id() }),
    ).toBeUndefined();
  });
});

describe('WagerTransaction', () => {
  test('nasce PENDING e não aceita OPENING', () => {
    const w = newWallet();
    expect(newTx(w, Kind.Bet, '1.00').status).toBe(Status.Pending);
    expect(() => newTx(w, Kind.Opening, '1.00')).toThrow(InvalidPayloadError);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    const w = newWallet();
    expect(() => newTx(w, Kind.Refund, '1.00')).toThrow(InvalidPayloadError);
    expect(() => newTx(w, Kind.Rollback, '1.00')).toThrow(InvalidPayloadError);
  });

  test('estados terminais não aceitam novas transições', () => {
    const w = newWallet();
    const tx = newTx(w, Kind.Bet, '1.00');
    run(w, tx);
    expect(tx.isTerminal()).toBe(true);
    expect(() =>
      tx.reject(FailureCode.InsufficientFunds, NOW, w.balance),
    ).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, NOW, w.balance)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('payloadHash diferente não bate', () => {
    const tx = newTx(newWallet(), Kind.Bet, '1.00');
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload('outro')).toBe(false);
  });
});

describe('regras de BET / WIN / LOSS', () => {
  test('BET debita e gera 1 lançamento DEBIT', () => {
    const w = newWallet('100.00');
    const tx = newTx(w, Kind.Bet, '30.00');
    const entry = run(w, tx);
    expect(tx.status).toBe(Status.Processed);
    expect(w.balance.amount).toBe('70.00');
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(tx.balanceSnapshot?.amount).toBe('70.00');
  });

  test('BET sem saldo é REJECTED, sem ledger e sem mexer no saldo', () => {
    const w = newWallet('10.00');
    const tx = newTx(w, Kind.Bet, '10.01');
    expect(run(w, tx)).toBeUndefined();
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('WIN credita', () => {
    const w = newWallet('10.00');
    const tx = newTx(w, Kind.Win, '5.00');
    expect(run(w, tx)?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('15.00');
  });

  test('LOSS não mexe no saldo, não gera ledger, mas fica PROCESSED', () => {
    const w = newWallet('10.00');
    const tx = newTx(w, Kind.Loss, '5.00');
    expect(run(w, tx)).toBeUndefined();
    expect(tx.status).toBe(Status.Processed);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    expect(tx.affectsBalance()).toBe(false);
  });

  test('moeda diferente da wallet é REJECTED CURRENCY_MISMATCH', () => {
    const w = newWallet();
    const tx = newTx(w, Kind.Bet, '1.00', { currency: 'USD' });
    run(w, tx);
    expect(tx.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(w.balance.amount).toBe('100.00');
  });

  test('wallet inexistente e player errado', () => {
    const w = newWallet();
    const t1 = newTx(w, Kind.Bet, '1.00');
    run(null, t1);
    expect(t1.failureCode).toBe(FailureCode.WalletNotFound);
    const t2 = newTx(w, Kind.Bet, '1.00', { playerId: 'outro' });
    run(w, t2);
    expect(t2.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });
});

describe('regras de REFUND / ROLLBACK', () => {
  function processedBet(w: Wallet, amount = '30.00') {
    const bet = newTx(w, Kind.Bet, amount);
    run(w, bet);
    return bet;
  }

  test('REFUND devolve o valor da BET', () => {
    const w = newWallet('100.00');
    const bet = processedBet(w);
    const refund = newTx(w, Kind.Refund, '30.00', {
      ref: bet.externalTransactionId,
    });
    const entry = run(w, refund, { reference: bet });
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('ROLLBACK de BET credita, de WIN debita, de REFUND debita', () => {
    const w = newWallet('100.00');
    const bet = processedBet(w);
    const win = newTx(w, Kind.Win, '50.00');
    run(w, win);
    const rbWin = newTx(w, Kind.Rollback, '50.00', {
      ref: win.externalTransactionId,
    });
    expect(run(w, rbWin, { reference: win })?.direction).toBe(
      LedgerDirection.Debit,
    );
    const rbBet = newTx(w, Kind.Rollback, '30.00', {
      ref: bet.externalTransactionId,
    });
    expect(run(w, rbBet, { reference: bet })?.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(w.balance.amount).toBe('100.00');
  });

  test('referência ausente fica PENDING_REFERENCE sem mexer no saldo', () => {
    const w = newWallet('100.00');
    const rb = newTx(w, Kind.Rollback, '30.00', { ref: 'ainda-nao-chegou' });
    expect(run(w, rb)).toBeUndefined();
    expect(rb.status).toBe(Status.PendingReference);
    expect(w.balance.amount).toBe('100.00');
  });

  test('esgotado o prazo, referência ausente vira REFERENCE_NOT_FOUND', () => {
    const w = newWallet();
    const rb = newTx(w, Kind.Refund, '30.00', { ref: 'nunca-chega' });
    run(w, rb);
    run(w, rb, { giveUpWaitingReference: true });
    expect(rb.status).toBe(Status.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('REFUND só referencia BET', () => {
    const w = newWallet();
    const win = newTx(w, Kind.Win, '5.00');
    run(w, win);
    const refund = newTx(w, Kind.Refund, '5.00', {
      ref: win.externalTransactionId,
    });
    run(w, refund, { reference: win });
    expect(refund.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('ROLLBACK de LOSS é inválido (não há o que desfazer)', () => {
    const w = newWallet();
    const loss = newTx(w, Kind.Loss, '5.00');
    run(w, loss);
    const rb = newTx(w, Kind.Rollback, '5.00', {
      ref: loss.externalTransactionId,
    });
    run(w, rb, { reference: loss });
    expect(rb.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('valor diferente da referência é AMOUNT_MISMATCH', () => {
    const w = newWallet();
    const bet = processedBet(w);
    const refund = newTx(w, Kind.Refund, '29.99', {
      ref: bet.externalTransactionId,
    });
    run(w, refund, { reference: bet });
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test('outra rodada ou outro player é REFERENCE_MISMATCH', () => {
    const w = newWallet();
    const bet = processedBet(w);
    const refund = newTx(w, Kind.Refund, '30.00', {
      ref: bet.externalTransactionId,
      roundId: 'outra',
    });
    run(w, refund, { reference: bet });
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('referência já revertida é REFERENCE_ALREADY_REVERSED', () => {
    const w = newWallet();
    const bet = processedBet(w);
    const refund = newTx(w, Kind.Refund, '30.00', {
      ref: bet.externalTransactionId,
    });
    run(w, refund, { reference: bet, referenceAlreadyReversed: true });
    expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('referência REJECTED não pode ser revertida', () => {
    const w = newWallet('1.00');
    const bet = newTx(w, Kind.Bet, '30.00');
    run(w, bet); // rejeitada por saldo
    const refund = newTx(w, Kind.Refund, '30.00', {
      ref: bet.externalTransactionId,
    });
    run(w, refund, { reference: bet });
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('reversão que deixaria saldo negativo usa código próprio', () => {
    const w = newWallet('0.00');
    const win = newTx(w, Kind.Win, '50.00');
    run(w, win);
    // o jogador gasta o prêmio
    run(w, newTx(w, Kind.Bet, '50.00'));
    const rb = newTx(w, Kind.Rollback, '50.00', {
      ref: win.externalTransactionId,
    });
    run(w, rb, { reference: win });
    expect(rb.status).toBe(Status.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('0.00');
  });
});

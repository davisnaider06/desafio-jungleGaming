import { describe, expect, test } from 'bun:test';
import { canonicalHash } from '../../shared/canonical-hash';
import { Money } from '../../shared/money';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../wagering/domain/wager-transaction';
import { Wallet } from '../../wallets/domain/wallet';
import { WagerTransactionProcessed, WalletBalanceChanged } from './events';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-01-01T00:00:00.000Z');
const ctx = { correlationId: 'corr-1', causationId: 'cause-1' };

function betAndWallet() {
  const wallet = Wallet.open({
    id: '00000000-0000-4000-8000-000000000001',
    playerId: 'p1',
    initialBalance: brl('100.00'),
    now: NOW,
  });
  const tx = WagerTransaction.create({
    id: '00000000-0000-4000-8000-000000000002',
    providerId: 'prov',
    externalTransactionId: 'e1',
    idempotencyKey: 'prov:e1',
    payloadHash: canonicalHash({}),
    walletId: wallet.id,
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    money: brl('30.00'),
    createdAt: NOW,
  });
  const entry = wallet.debit({
    entryId: '00000000-0000-4000-8000-000000000003',
    transactionId: tx.id,
    money: tx.money,
    at: NOW,
  });
  tx.markProcessed(undefined, NOW, wallet.balance);
  return { wallet, tx, entry };
}

describe('IntegrationEvent', () => {
  test('WalletBalanceChanged: envelope e data só com tipos simples', () => {
    const { wallet, entry } = betAndWallet();
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = JSON.parse(JSON.stringify(event));

    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'cause-1',
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: 'DEBIT',
        money: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(typeof json.eventId).toBe('string');
    expect(json.occurredAt).toBe(event.occurredAt.toISOString());
  });

  test('data é somente leitura e eventType/version são fixos por classe', () => {
    const { tx } = betAndWallet();
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(() => {
      (event.data as { kind: string }).kind = 'WIN';
    }).toThrow();
  });

  test('cada evento recebe um eventId diferente', () => {
    const { tx } = betAndWallet();
    expect(WagerTransactionProcessed.from(tx, ctx).eventId).not.toBe(
      WagerTransactionProcessed.from(tx, ctx).eventId,
    );
  });
});

describe('OutboxMessage', () => {
  const make = () => {
    const { tx } = betAndWallet();
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx));
  };

  test('nasce pendente e vencida; usa o eventId como id', () => {
    const message = make();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date())).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.payload.eventId).toBe(message.id);
  });

  test('scheduleRetry conta a tentativa e dobra o atraso até o teto', () => {
    const message = make();
    const now = new Date('2026-01-01T00:00:00.000Z');
    message.scheduleRetry(now, 1000, 5000);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(1000);
    message.scheduleRetry(now, 1000, 5000);
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(2000);
    message.scheduleRetry(now, 1000, 5000);
    message.scheduleRetry(now, 1000, 5000);
    expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(5000); // teto
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 5000))).toBe(true);
  });

  test('markPublished tira da fila de pendentes', () => {
    const message = make();
    message.markPublished(new Date());
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date())).toBe(false);
  });
});

describe('InboxMessage', () => {
  test('nasce não processada e vira processada', () => {
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(NOW);
  });
});

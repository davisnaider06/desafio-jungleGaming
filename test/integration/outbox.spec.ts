import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { OutboxRepository } from '../../src/persistence/outbox.repository';
import {
  TestApp,
  createWallet,
  expectLedgerConsistent,
  http,
  startApp,
  submit,
  truncateAll,
  wagerRequest,
} from '../support/app';
import { TestQueues, drain, purgeAll, setupQueues } from '../support/sqs';

let t: TestApp;
let q: TestQueues;
let publisher: OutboxPublisher;

beforeAll(async () => {
  q = await setupQueues();
  t = await startApp();
  publisher = t.app.get(OutboxPublisher);
});
afterAll(async () => {
  await t.close();
  q.client.destroy();
});
beforeEach(async () => {
  await truncateAll(t.em());
  await purgeAll(q);
});

const sql = (query: string, params: unknown[] = []) =>
  t.em().getConnection().execute(query, params);

const outboxTypes = async () =>
  (
    await sql(
      'select event_type from outbox_messages order by occurred_at, event_type',
    )
  ).map((r: any) => r.event_type);

describe('eventos nascem na mesma transação da mudança financeira', () => {
  test('BET gera WagerTransactionProcessed + WalletBalanceChanged', async () => {
    const w = await createWallet(t, '100.00');
    await sql('delete from outbox_messages'); // ignora o evento de abertura
    await submit(t, wagerRequest(w, 'BET', '30.00'));
    expect((await outboxTypes()).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const [changed] = await sql(
      `select payload from outbox_messages where event_type = 'WalletBalanceChanged'`,
    );
    expect(changed.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: w.id,
      data: {
        walletId: w.id,
        direction: 'DEBIT',
        money: { amount: '30.00', currency: 'BRL' }, // string, nunca number
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(typeof changed.payload.eventId).toBe('string');
    expect(typeof changed.payload.correlationId).toBe('string');
    expect(new Date(changed.payload.occurredAt).toISOString()).toBe(
      changed.payload.occurredAt,
    );
  });

  test('LOSS gera só Processed (o saldo não mudou); rejeição gera só Rejected', async () => {
    const w = await createWallet(t, '10.00');
    await sql('delete from outbox_messages');
    await submit(t, wagerRequest(w, 'LOSS', '5.00'));
    expect(await outboxTypes()).toEqual(['WagerTransactionProcessed']);

    await sql('delete from outbox_messages');
    await submit(t, wagerRequest(w, 'BET', '999.00'));
    expect(await outboxTypes()).toEqual(['WagerTransactionRejected']);
    const [rejected] = await sql(`select payload from outbox_messages`);
    expect(rejected.payload.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('replay NÃO gera eventos novos', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '10.00');
    await submit(t, req);
    const before = (await outboxTypes()).length;
    await submit(t, req);
    await submit(t, req);
    expect((await outboxTypes()).length).toBe(before);
  });

  test('criar wallet com saldo gera WalletBalanceChanged (CREDIT)', async () => {
    await createWallet(t, '25.00');
    const [row] = await sql(`select payload from outbox_messages`);
    expect(row.payload.data).toMatchObject({
      direction: 'CREDIT',
      walletVersion: 1,
    });
  });

  test('ATOMICIDADE: se a gravação do evento falha, saldo, ledger e transação são desfeitos', async () => {
    const w = await createWallet(t, '100.00');
    await sql('delete from outbox_messages');

    const repo = t.app.get(OutboxRepository);
    const original = repo.insertAll.bind(repo);
    repo.insertAll = async () => {
      throw new Error('falha injetada ao gravar na outbox');
    };
    try {
      const res = await submit(t, wagerRequest(w, 'BET', '40.00'));
      expect(res.status).toBe(500);
    } finally {
      repo.insertAll = original;
    }

    // Nada ficou: o débito, o lançamento e a transação sumiram junto com o evento.
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${w.id}`)).body.balance.amount,
    ).toBe('100.00');
    expect(
      await sql(
        `select count(*)::int as n from wager_transactions where kind = 'BET'`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await sql(`select count(*)::int as n from wallet_ledger_entries`),
    ).toEqual([{ n: 1 }]);
    expect(await sql('select count(*)::int as n from outbox_messages')).toEqual(
      [{ n: 0 }],
    );
    // e NADA foi publicado
    await publisher.runOnce();
    expect(await drain(q, q.eventsUrl)).toHaveLength(0);
    await expectLedgerConsistent(t, w.id);
  });
});

describe('publisher', () => {
  test('publica o que está confirmado, marca como publicado e não republica', async () => {
    const w = await createWallet(t, '100.00');
    await submit(t, wagerRequest(w, 'BET', '10.00'));
    await submit(t, wagerRequest(w, 'WIN', '5.00'));
    const total = (
      await sql('select count(*)::int as n from outbox_messages')
    )[0].n;

    const first = await publisher.runOnce();
    expect(first).toEqual({ published: total, failed: 0 });
    const second = await publisher.runOnce();
    expect(second.published).toBe(0);

    const messages = await drain(q, q.eventsUrl);
    expect(messages).toHaveLength(total);
    const ids = messages.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(ids).size).toBe(total);
    expect(
      await sql(
        'select count(*)::int as n from outbox_messages where published_at is null',
      ),
    ).toEqual([{ n: 0 }]);
  });

  test('dois publishers ao mesmo tempo: cada evento é publicado exatamente uma vez', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 8 }, () => createWallet(t, '1000.00')),
    );
    for (const w of wallets) {
      for (let i = 0; i < 5; i++)
        await submit(t, wagerRequest(w, 'BET', '1.00'));
    }
    const total = (
      await sql('select count(*)::int as n from outbox_messages')
    )[0].n;
    expect(total).toBeGreaterThan(80);

    // Dois publishers (e uma terceira instância do serviço, via mesma classe) disputando a mesma tabela.
    const runs = await Promise.all([
      publisher.runOnce(),
      publisher.runOnce(),
      publisher.runOnce(),
    ]);
    // Cada linha foi enviada por UM publisher só (SKIP LOCKED): a soma bate com o total, sem sobra.
    expect(runs.reduce((sum, r) => sum + r.published, 0)).toBe(total);
    expect(runs.filter((r) => r.published > 0).length).toBeGreaterThanOrEqual(
      1,
    );

    const messages = await drain(q, q.eventsUrl);
    const ids = messages.map((m) => JSON.parse(m.Body!).eventId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
  });

  test('processo morre depois de enviar e antes do commit: outra instância assume e a duplicata é inofensiva', async () => {
    const w = await createWallet(t, '100.00');
    await submit(t, wagerRequest(w, 'BET', '10.00'));
    const total = (
      await sql('select count(*)::int as n from outbox_messages')
    )[0].n;

    // A "morre": envia para a fila e cai antes de confirmar no banco (rollback).
    await expect(
      publisher.runOnce({
        beforeCommit: async () => {
          throw new Error('processo morreu');
        },
      }),
    ).rejects.toThrow('processo morreu');
    // O banco continua dizendo "pendente": nada se perdeu.
    expect(
      await sql(
        'select count(*)::int as n from outbox_messages where published_at is null',
      ),
    ).toEqual([{ n: total }]);

    // B assume e publica.
    expect((await publisher.runOnce()).published).toBe(total);
    expect(
      await sql(
        'select count(*)::int as n from outbox_messages where published_at is null',
      ),
    ).toEqual([{ n: 0 }]);

    // Pode ter chegado duplicado (at-least-once), mas o consumidor reconhece pelo eventId.
    const messages = await drain(q, q.eventsUrl);
    const ids = new Set(messages.map((m) => JSON.parse(m.Body!).eventId));
    expect(ids.size).toBe(total);
    expect(messages.length).toBeGreaterThanOrEqual(total);
  });

  test('falha ao publicar: agenda nova tentativa com backoff e publica quando a fila volta', async () => {
    const w = await createWallet(t, '100.00');
    const total = (
      await sql('select count(*)::int as n from outbox_messages')
    )[0].n;

    // Fila de eventos "fora do ar": o SQS recusa o envio.
    const sqs = (publisher as any).sqs;
    const originalSend = sqs.client.send.bind(sqs.client);
    sqs.client.send = async () => {
      throw Object.assign(new Error('SQS indisponível'), {
        name: 'ServiceUnavailable',
      });
    };
    let result;
    try {
      result = await publisher.runOnce();
    } finally {
      sqs.client.send = originalSend;
    }
    expect(result).toEqual({ published: 0, failed: total });
    const [row] = await sql(
      'select attempts, next_attempt_at > now() as later from outbox_messages',
    );
    expect(row).toEqual({ attempts: 1, later: true });

    // Evento continua no banco; assim que o backoff passa, é publicado.
    await new Promise((r) => setTimeout(r, 250));
    expect((await publisher.runOnce()).published).toBe(total);
    expect(await drain(q, q.eventsUrl)).toHaveLength(total);
    expect(w.id).toBeString();
  });
});

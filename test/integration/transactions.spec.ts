import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { Database } from '../../src/persistence/database.service';
import { InboxRepository } from '../../src/persistence/inbox.repository';
import { OutboxRepository } from '../../src/persistence/outbox.repository';
import {
  TestApp,
  createWallet,
  startApp,
  submit,
  truncateAll,
  wagerRequest,
} from '../support/app';
import { TestQueues, drain, purgeAll, setupQueues } from '../support/sqs';

/**
 * Regressão de um bug real encontrado pelo teste de 3 instâncias com kill -9:
 * consultas SQL cruas feitas por `getConnection().execute()` NÃO participam da transação do
 * `em.transactional()`. O registro do inbox era confirmado sozinho (autocommit); se o processo
 * morresse antes do commit financeiro, a reentrega achava "já processada" e a aposta se perdia.
 * Aqui provamos que o inbox e os locks SKIP LOCKED agora vivem DENTRO da transação.
 */
let t: TestApp;
let q: TestQueues;
let db: Database;

beforeAll(async () => {
  q = await setupQueues();
  t = await startApp();
  db = t.app.get(Database);
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

describe('SQL cru dentro da transação', () => {
  test('o inbox é desfeito junto com a transação (rollback não deixa "já vi" para trás)', async () => {
    const inbox = t.app.get(InboxRepository);
    const message = InboxMessage.receive({
      messageId: 'm-1',
      consumerName: 'c',
      payloadHash: 'a'.repeat(64),
    });

    await expect(
      db.transaction(async (em) => {
        expect(await inbox.receive(em, message)).toBe(true);
        throw new Error('processo caiu antes do commit');
      }),
    ).rejects.toThrow('antes do commit');

    expect(await sql('select count(*)::int as n from inbox_messages')).toEqual([
      { n: 0 },
    ]);
    // e a mensagem pode ser registrada normalmente na reentrega
    await db.transaction(async (em) => {
      expect(await inbox.receive(em, message)).toBe(true);
    });
    expect(await sql('select count(*)::int as n from inbox_messages')).toEqual([
      { n: 1 },
    ]);
  });

  test('o lock FOR UPDATE SKIP LOCKED da outbox dura até o fim da transação', async () => {
    const w = await createWallet(t, '100.00');
    await submit(t, wagerRequest(w, 'BET', '1.00'));
    const outbox = t.app.get(OutboxRepository);
    const total = (
      await sql('select count(*)::int as n from outbox_messages')
    )[0].n;
    expect(total).toBeGreaterThan(1);

    await db.transaction(async (em1) => {
      const mine = await outbox.lockDue(em1, new Date(), 100);
      expect(mine).toHaveLength(total);

      // Enquanto a transação 1 está aberta, outra transação NÃO enxerga essas linhas.
      const others = await db.transaction((em2) =>
        outbox.lockDue(em2, new Date(), 100),
      );
      expect(others).toHaveLength(0);
    });

    // Depois do fim da transação 1, as linhas voltam a ficar disponíveis.
    const after = await db.transaction((em) =>
      outbox.lockDue(em, new Date(), 100),
    );
    expect(after).toHaveLength(total);
  });
});

describe('publishers concorrentes com envio lento', () => {
  test('3 publishers disputando a mesma outbox: nenhuma linha é enviada duas vezes', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => createWallet(t, '500.00')),
    );
    for (const w of wallets) {
      for (let i = 0; i < 6; i++)
        await submit(t, wagerRequest(w, 'BET', '1.00'));
    }
    const total = (
      await sql('select count(*)::int as n from outbox_messages')
    )[0].n;

    // Cada envio demora, para os publishers realmente se sobreporem no tempo.
    const publisher = t.app.get(OutboxPublisher);
    const sqs = (publisher as any).sqs;
    const send = sqs.client.send.bind(sqs.client);
    let sends = 0;
    sqs.client.send = async (...args: unknown[]) => {
      // conta só os envios de evento (ignora GetQueueUrl e afins)
      if (args[0]?.constructor?.name === 'SendMessageCommand') sends += 1;
      await new Promise((r) => setTimeout(r, 25));
      return send(...args);
    };
    let runs;
    try {
      runs = await Promise.all([
        publisher.runOnce(),
        publisher.runOnce(),
        publisher.runOnce(),
      ]);
    } finally {
      sqs.client.send = send;
    }

    // Se dois publishers pegassem a mesma linha, a soma passaria do total e haveria mais envios que linhas.
    expect(runs.reduce((sum, r) => sum + r.published, 0)).toBe(total);
    expect(sends).toBe(total);
    expect(runs.filter((r) => r.published > 0).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(await drain(q, q.eventsUrl)).toHaveLength(total);
  });
});

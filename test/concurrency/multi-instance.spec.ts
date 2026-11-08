import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  TestApp,
  brl,
  createWallet,
  expectLedgerConsistent,
  http,
  startApp,
  truncateAll,
  wagerRequest,
} from '../support/app';
import { Instance, startInstance, startInstances } from '../support/instances';
import {
  TestQueues,
  drain,
  eventually,
  purgeAll,
  sendWager,
  setupQueues,
  sleep,
  depth,
} from '../support/sqs';

/**
 * Aqui o serviço roda como PROCESSOS SEPARADOS (como em produção com várias réplicas),
 * todos contra o mesmo Postgres e as mesmas filas. O processo do teste só envia carga e confere o resultado.
 */
let t: TestApp; // usado só para criar wallets, consultar o banco e conferir
let q: TestQueues;
let instances: Instance[] = [];

beforeAll(async () => {
  q = await setupQueues();
  t = await startApp();
});
afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill().catch(() => undefined)));
  await t.close();
  q.client.destroy();
});
beforeEach(async () => {
  await Promise.all(instances.map((i) => i.kill().catch(() => undefined)));
  instances = [];
  await truncateAll(t.em());
  await purgeAll(q);
});

const sql = (query: string, params: unknown[] = []) =>
  t.em().getConnection().execute(query, params);

/** Distribui as chamadas HTTP entre as instâncias (round robin). */
function roundRobin(list: Instance[]) {
  let i = 0;
  return () => list[i++ % list.length].baseUrl;
}

const post = (
  baseUrl: string,
  req: { body: unknown; idempotencyKey: string },
) =>
  http(baseUrl, 'POST', '/wagering/transactions', {
    body: req.body,
    headers: { 'idempotency-key': req.idempotencyKey },
  });

describe('3 instâncias (processos) simultâneas via HTTP', () => {
  test('100/80 em várias wallets, a mesma aposta 60x e hot wallet: nenhuma invariante quebra', async () => {
    instances = await startInstances(3, { SQS_CONSUMER: 'off' });
    const next = roundRobin(instances);

    // 1) 100/80 em 15 wallets, as duas disputas caindo em instâncias diferentes
    const wallets = await Promise.all(
      Array.from({ length: 15 }, () => createWallet(t, '100.00')),
    );
    await Promise.all(
      wallets.flatMap((w) => [
        post(next(), wagerRequest(w, 'BET', '80.00')),
        post(next(), wagerRequest(w, 'BET', '80.00')),
      ]),
    );
    for (const w of wallets) {
      const rows = await sql(
        `select status from wager_transactions where wallet_id = ? and kind = 'BET' order by status`,
        [w.id],
      );
      expect(rows.map((r: any) => r.status)).toEqual(['PROCESSED', 'REJECTED']);
      expect(
        (await http(t.baseUrl, 'GET', `/wallets/${w.id}`)).body.balance,
      ).toEqual(brl('20.00'));
      await expectLedgerConsistent(t, w.id);
    }

    // 2) a MESMA aposta 60 vezes, espalhada pelas 3 instâncias: um único débito
    const single = await createWallet(t, '100.00');
    const req = wagerRequest(single, 'BET', '30.00');
    const results = await Promise.all(
      Array.from({ length: 60 }, () => post(next(), req)),
    );
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(
      results.filter((r) => r.body.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${single.id}`)).body.balance,
    ).toEqual(brl('70.00'));
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
        [single.id],
      ),
    ).toEqual([{ n: 1 }]);

    // 3) hot wallet: 90 apostas diferentes de 1.00 numa wallet com 60.00, vindas das 3 instâncias
    const hot = await createWallet(t, '60.00');
    const hotResults = await Promise.all(
      Array.from({ length: 90 }, () =>
        post(next(), wagerRequest(hot, 'BET', '1.00')),
      ),
    );
    expect(
      hotResults.filter((r) => r.body.status === 'PROCESSED'),
    ).toHaveLength(60);
    expect(
      hotResults.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(30);
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${hot.id}`)).body.balance,
    ).toEqual(brl('0.00'));
    await expectLedgerConsistent(t, hot.id);
    await expectLedgerConsistent(t, single.id);
  });
});

describe('3 instâncias consumindo a mesma fila, publicando a mesma outbox', () => {
  const WALLETS = 12;
  const BETS = 10;

  async function sendBets(
    wallets: { id: string; playerId: string }[],
    count: number,
    tag: string,
  ) {
    const expected: { id: string; bets: number }[] = wallets.map((w) => ({
      id: w.id,
      bets: count,
    }));
    for (const w of wallets) {
      for (let i = 0; i < count; i++) {
        const req = wagerRequest(w, 'BET', '5.00', {
          externalTransactionId: `${tag}-${w.id}-${i}`,
        });
        const messageId = randomUUID();
        await sendWager(q, req, messageId);
        await sendWager(q, req, messageId); // entrega duplicada da mesma mensagem
      }
    }
    return expected;
  }

  /**
   * Espera o BANCO mostrar o efeito de todas as apostas (e não o contador da fila, que é aproximado).
   * Se uma mensagem se perdesse de verdade, esta espera estouraria o tempo e o teste falharia.
   */
  const waitForBets = (expected: number) =>
    eventually(
      async () => {
        const [{ n }] = await sql(
          `select count(*)::int as n from wager_transactions where kind = 'BET' and status = 'PROCESSED'`,
        );
        if (n !== expected) throw new Error(`${n}/${expected} bets applied`);
      },
      90_000,
      500,
    );

  test('mensagens duplicadas + uma instância morta (kill -9) no meio + reinício: tudo aplicado exatamente uma vez', async () => {
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => createWallet(t, '1000.00')),
    );
    instances = await startInstances(3);

    // Fase 1: carga normal, cada mensagem entregue em duplicidade
    await sendBets(wallets, BETS, 'fase1');
    await waitForBets(WALLETS * BETS);

    // Fase 2: mata a instância #2 NO MEIO do processamento e depois a reinicia
    await sendBets(wallets, BETS, 'fase2');
    await sleep(700);
    await instances[1].kill();
    await sleep(500);
    const reborn = await startInstance();
    instances[1] = reborn;
    await waitForBets(WALLETS * BETS * 2);

    // Consistência final: cada aposta aplicada UMA vez, apesar de duplicadas, kill -9 e reinício
    for (const w of wallets) {
      const res = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
      expect(res.body.balance).toEqual(brl('900.00')); // 1000 - 20 apostas x 5.00
      expect(
        await sql(
          `select count(*)::int as n from wager_transactions where wallet_id = ? and kind = 'BET'`,
          [w.id],
        ),
      ).toEqual([{ n: BETS * 2 }]);
      expect(
        await sql(
          `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
          [w.id],
        ),
      ).toEqual([{ n: BETS * 2 }]);
      await expectLedgerConsistent(t, w.id);
    }
    // nenhuma mensagem acabou na DLQ e todas foram confirmadas no inbox exatamente uma vez
    expect(await depth(q, q.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    expect(await sql('select count(*)::int as n from inbox_messages')).toEqual([
      { n: WALLETS * BETS * 2 },
    ]);

    // Outbox: os publishers das 3 instâncias esvaziam a tabela e cada evento sai pelo menos uma vez, sem se perder
    await eventually(
      async () => {
        const [{ n }] = await sql(
          'select count(*)::int as n from outbox_messages where published_at is null',
        );
        if (n > 0) throw new Error(`${n} events still pending`);
      },
      60_000,
      500,
    );
    const [{ total }] = await sql(
      'select count(*)::int as total from outbox_messages',
    );
    const published = await drain(q, q.eventsUrl, 3);
    const ids = new Set(published.map((m) => JSON.parse(m.Body!).eventId));
    expect(ids.size).toBe(total); // nenhum evento confirmado foi perdido
    // e ninguém publicou o mesmo evento indefinidamente
    expect(published.length).toBeLessThanOrEqual(total * 2);

    // Métricas expostas por uma instância
    const metrics = await (
      await fetch(`${instances[0].baseUrl}/metrics`)
    ).text();
    expect(metrics).toContain('outbox_lag_seconds');
  });
});

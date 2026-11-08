import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config';
import {
  TestApp,
  createWallet,
  expectLedgerConsistent,
  http,
  startApp,
  truncateAll,
  wagerRequest,
} from '../support/app';
import { Instance, startInstance } from '../support/instances';
import {
  TestQueues,
  depth,
  eventually,
  purgeAll,
  sendWager,
  setupQueues,
  sleep,
} from '../support/sqs';
import { TcpProxy } from '../support/tcp-proxy';

/**
 * Banco indisponível DE VERDADE (sem injetar exceção): a aplicação roda num processo à parte e
 * fala com o Postgres através de um proxy TCP que pode derrubar as conexões ou recusá-las.
 * O erro que chega ao código é o do driver real, não um objeto criado no teste.
 *
 * Achado da prova de fogo manual: com o Postgres parado, o `pg` lança um `Error` SEM `code`
 * ("Connection terminated unexpectedly") e a API respondia 500 em vez de 503.
 */
let t: TestApp; // acesso direto ao banco (sem proxy) para conferir o estado
let q: TestQueues;
let proxy: TcpProxy;
const instances: Instance[] = [];

beforeAll(async () => {
  const { db } = loadConfig();
  q = await setupQueues();
  t = await startApp();
  proxy = new TcpProxy({ host: db.host, port: db.port });
  await proxy.start();
});
afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill()));
  await proxy.stop();
  await t.close();
  q.client.destroy();
});
beforeEach(async () => {
  await proxy.setMode('forward');
  await truncateAll(t.em());
  await purgeAll(q);
});

/** Instância real cujo banco passa pelo proxy. */
async function startBehindProxy(env: Record<string, string> = {}) {
  const instance = await startInstance({
    DB_HOST: '127.0.0.1',
    DB_PORT: String(proxy.port),
    OUTBOX_WORKER: 'off',
    SQS_CONSUMER: 'off',
    PENDING_WORKER: 'off',
    ...env,
  });
  instances.push(instance);
  return instance;
}

/** Apostas gravadas (a criação da wallet já grava uma transação OPENING). */
const BETS_COUNT =
  "select count(*)::int as n from wager_transactions where kind <> 'OPENING'";

const sql = (query: string, params: unknown[] = []) =>
  t.em().getConnection().execute(query, params);

async function post(
  baseUrl: string,
  req: { body: unknown; idempotencyKey: string },
) {
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': req.idempotencyKey,
    },
    body: JSON.stringify(req.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: text ? JSON.parse(text) : undefined,
  };
}

/** Aquece o pool da instância: depois disso ela tem conexões abertas (que vão morrer). */
async function warmUp(instance: Instance) {
  expect((await http(instance.baseUrl, 'GET', '/health/ready')).status).toBe(
    200,
  );
}

for (const mode of ['drop', 'close', 'refuse'] as const) {
  test(`banco caindo de verdade (${mode}): 503 + Retry-After, nada gravado, reenvio com a mesma chave debita uma vez`, async () => {
    const instance = await startBehindProxy();
    const w = await createWallet(t, '100.00');
    await warmUp(instance);
    const req = wagerRequest(w, 'BET', '10.00');

    await proxy.setMode(mode);
    // 1ª e 2ª tentativas: os erros do driver mudam (ECONNRESET, "Connection terminated
    // unexpectedly", ECONNREFUSED...). Todos têm de virar 503.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await post(instance.baseUrl, req);
      expect(res.status, `tentativa ${attempt}`).toBe(503);
      expect(res.retryAfter).not.toBeNull();
      expect(res.body.error.code).toBe('TRANSIENT_FAILURE');
    }

    // Nada foi gravado.
    expect(await sql(BETS_COUNT)).toEqual([{ n: 0 }]);
    expect(
      await sql(
        'select balance::text as balance, version from wallets where id = ?',
        [w.id],
      ),
    ).toEqual([{ balance: '100.00', version: 1 }]);

    // O banco volta; o provedor reenvia com a MESMA chave: um só débito.
    await proxy.setMode('forward');
    const first = await eventually(async () => {
      const res = await post(instance.baseUrl, req);
      if (res.status !== 201)
        throw new Error(`esperava 201, veio ${res.status}`);
      return res;
    }, 20_000);
    expect(first.status).toBe(201);
    expect((await post(instance.baseUrl, req)).status).toBe(200);

    expect(
      await sql('select balance::text as balance from wallets where id = ?', [
        w.id,
      ]),
    ).toEqual([{ balance: '90.00' }]);
    expect(await sql(BETS_COUNT)).toEqual([{ n: 1 }]);
    await expectLedgerConsistent(t, w.id);
  });
}

test('consumidor SQS com o banco caindo de verdade: a mensagem volta (retry) e NÃO vai para a DLQ; processa uma vez', async () => {
  await startBehindProxy({
    SQS_CONSUMER: 'on',
    SQS_RETRY_BASE_SECONDS: '1',
  });
  const w = await createWallet(t, '100.00');
  const req = wagerRequest(w, 'BET', '25.00');

  await proxy.setMode('close');
  const before = proxy.droppedConnections;
  await sendWager(q, req);

  // O consumidor tenta, o banco derruba a conexão e a mensagem não é confirmada.
  await eventually(async () => {
    if (proxy.droppedConnections <= before)
      throw new Error('o consumidor ainda não tentou o banco');
  }, 20_000);
  await sleep(300);
  expect(await sql(BETS_COUNT)).toEqual([{ n: 0 }]);
  const dlqWhileDown = await depth(q, q.dlqUrl);
  expect(dlqWhileDown.visible + dlqWhileDown.inFlight).toBe(0);

  // O banco volta antes de estourar o limite de tentativas: a reentrega funciona.
  await proxy.setMode('forward');
  await eventually(async () => {
    const rows = await sql(
      'select balance::text as balance from wallets where id = ?',
      [w.id],
    );
    if (rows[0].balance !== '75.00')
      throw new Error(`saldo ${rows[0].balance}`);
  }, 30_000);

  expect(await sql(BETS_COUNT)).toEqual([{ n: 1 }]);
  const dlqAfter = await depth(q, q.dlqUrl);
  expect(dlqAfter.visible + dlqAfter.inFlight).toBe(0);
  await expectLedgerConsistent(t, w.id);
});

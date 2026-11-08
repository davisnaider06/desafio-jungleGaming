import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ConnectionException } from '@mikro-orm/core';
import { setLogSink } from '../../src/observability/logger';
import { Database } from '../../src/persistence/database.service';
import { SimulatedCrash, SqsConsumer } from '../../src/messaging/sqs-consumer';
import {
  TestApp,
  createWallet,
  expectLedgerConsistent,
  http,
  startApp,
  truncateAll,
  wagerRequest,
} from '../support/app';
import {
  TestQueues,
  depth,
  drain,
  eventually,
  purgeAll,
  sendRaw,
  sendWager,
  setupQueues,
  sleep,
} from '../support/sqs';

let t: TestApp;
let q: TestQueues;
let consumer: SqsConsumer;

beforeAll(async () => {
  setLogSink(() => undefined); // os erros esperados (DLQ) não precisam poluir a saída
  q = await setupQueues();
  t = await startApp();
  consumer = t.app.get(SqsConsumer);
});
afterAll(async () => {
  await t.close();
  q.client.destroy();
});
beforeEach(async () => {
  await truncateAll(t.em());
  await purgeAll(q);
  consumer.restart();
  consumer.beforeAck = undefined;
});

const sql = (query: string, params: unknown[] = []) =>
  t.em().getConnection().execute(query, params);

const balanceOf = async (walletId: string) =>
  (await http(t.baseUrl, 'GET', `/wallets/${walletId}`)).body.balance.amount;

/** Roda ciclos de polling até a fila de transações esvaziar (visível e em processamento). */
async function pollUntilIdle(timeoutMs = 20_000) {
  await eventually(
    async () => {
      await consumer.pollOnce();
      const d = await depth(q, q.transactionsUrl);
      if (d.visible + d.inFlight > 0)
        throw new Error(`queue not empty: ${JSON.stringify(d)}`);
    },
    timeoutMs,
    100,
  );
}

describe('consumo básico', () => {
  test('mensagem válida: processa com o mesmo caso de uso, registra o inbox e só então confirma', async () => {
    const w = await createWallet(t, '100.00');
    const messageId = await sendWager(q, wagerRequest(w, 'BET', '30.00'));

    await pollUntilIdle();

    expect(await balanceOf(w.id)).toBe('70.00');
    const inbox = await sql(
      'select consumer_name, message_id, processed_at is not null as done from inbox_messages',
    );
    expect(inbox).toEqual([
      {
        consumer_name: 'wager-transactions-consumer',
        message_id: messageId,
        done: true,
      },
    ]);
    expect(await depth(q, q.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    await expectLedgerConsistent(t, w.id);
  });

  test('regra de negócio (saldo insuficiente) não é erro: vira REJECTED e a mensagem é confirmada', async () => {
    const w = await createWallet(t, '10.00');
    await sendWager(q, wagerRequest(w, 'BET', '50.00'));
    await pollUntilIdle();

    const rows = await sql(
      `select status, failure_code from wager_transactions where kind = 'BET'`,
    );
    expect(rows).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    expect(await depth(q, q.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
  });

  test('o providerId vindo da fila passa pelas mesmas validações (campo inválido => DLQ)', async () => {
    const w = await createWallet(t, '10.00');
    const req = wagerRequest(w, 'BET', '1.00', { providerId: '' });
    await sendWager(q, req);
    await pollUntilIdle();
    expect(
      await sql(
        `select count(*)::int as n from wager_transactions where kind = 'BET'`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(await drain(q, q.dlqUrl)).toHaveLength(1);
  });
});

describe('redelivery sem duplicar efeito', () => {
  test('a MESMA mensagem entregue duas vezes (inbox) gera um único débito', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '25.00');
    const messageId = randomUUID();
    // Dois envios com o mesmo messageId e dedup ids diferentes: o FIFO não consegue deduplicar,
    // quem protege é o inbox persistente.
    await sendWager(q, req, messageId);
    await sendWager(q, req, messageId);
    await pollUntilIdle();

    expect(await balanceOf(w.id)).toBe('75.00');
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where direction = 'DEBIT'`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(await sql('select count(*)::int as n from inbox_messages')).toEqual([
      { n: 1 },
    ]);
  });

  test('outro messageId com a mesma Idempotency-Key (produtor reenviou) também não duplica', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '25.00');
    await sendWager(q, req);
    await sendWager(q, req); // messageId novo
    await pollUntilIdle();
    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await sql('select count(*)::int as n from inbox_messages')).toEqual([
      { n: 2 },
    ]);
  });

  test('worker morre DEPOIS do commit e ANTES do ack: a fila reentrega e o débito não se repete', async () => {
    const w = await createWallet(t, '100.00');
    await sendWager(q, wagerRequest(w, 'BET', '40.00'));

    // 1ª entrega: o caso de uso confirma o commit e o "processo morre" antes do DeleteMessage.
    consumer.beforeAck = async () => {
      throw new SimulatedCrash('morreu antes do ack');
    };
    await consumer.pollOnce();
    expect(await balanceOf(w.id)).toBe('60.00'); // já estava commitado
    expect(await depth(q, q.transactionsUrl)).toEqual({
      visible: 0,
      inFlight: 1,
    }); // sem ack

    // Outro worker assume quando a visibilidade expira (2s nos testes).
    consumer.beforeAck = undefined;
    await sleep(2200);
    await pollUntilIdle();

    expect(await balanceOf(w.id)).toBe('60.00'); // continua 60: nada de segundo débito
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where direction = 'DEBIT'`,
      ),
    ).toEqual([{ n: 1 }]);
    await expectLedgerConsistent(t, w.id);
  });
});

describe('falhas', () => {
  test('erro PERMANENTE (JSON inválido, envelope errado) vai direto para a DLQ', async () => {
    await sendRaw(q, 'isto não é json', 'g1');
    await sendRaw(
      q,
      JSON.stringify({ type: 'OutroTipo', messageId: 'x', data: {} }),
      'g2',
    );
    await pollUntilIdle();
    const dead = await drain(q, q.dlqUrl);
    expect(dead).toHaveLength(2);
    expect(dead[0].MessageAttributes?.reason?.StringValue).toBe('permanent');
    expect(await depth(q, q.transactionsUrl)).toEqual({
      visible: 0,
      inFlight: 0,
    });
  });

  test('erro TRANSITÓRIO: a mensagem volta com backoff e é processada quando o banco volta', async () => {
    const w = await createWallet(t, '100.00');
    await sendWager(q, wagerRequest(w, 'BET', '10.00'));

    // Postgres "cai" nas duas primeiras tentativas.
    const db = t.app.get(Database);
    const original = db.transaction.bind(db);
    let failures = 2;
    db.transaction = (async (fn: any) => {
      if (failures-- > 0)
        throw new ConnectionException(new Error('banco indisponível'));
      return original(fn);
    }) as typeof db.transaction;
    try {
      await pollUntilIdle(30_000);
    } finally {
      db.transaction = original;
    }

    expect(failures).toBeLessThan(0); // as duas falhas aconteceram
    expect(await balanceOf(w.id)).toBe('90.00'); // processada UMA vez, na terceira tentativa
    expect(await depth(q, q.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
    await expectLedgerConsistent(t, w.id);
  });

  test('erro transitório que não passa: estoura o limite de tentativas e vai para a DLQ', async () => {
    const w = await createWallet(t, '100.00');
    await sendWager(q, wagerRequest(w, 'BET', '10.00'));

    const db = t.app.get(Database);
    const original = db.transaction.bind(db);
    db.transaction = (async () => {
      throw new ConnectionException(new Error('banco indisponível'));
    }) as typeof db.transaction;
    try {
      await pollUntilIdle(40_000);
    } finally {
      db.transaction = original;
    }

    const dead = await drain(q, q.dlqUrl);
    expect(dead).toHaveLength(1);
    expect(dead[0].MessageAttributes?.reason?.StringValue).toBe(
      'retries_exhausted',
    );
    expect(await balanceOf(w.id)).toBe('100.00'); // nunca processou
  });
});

describe('desligamento (SIGTERM)', () => {
  test('ao parar, o que não foi iniciado volta para a fila na hora e nada é perdido nem duplicado', async () => {
    const w = await createWallet(t, '1000.00');
    for (let i = 0; i < 5; i++)
      await sendWager(q, wagerRequest(w, 'BET', '10.00'));

    // Pede para parar durante a 1ª mensagem do lote: ela termina (commit + ack), as outras são devolvidas.
    let acked = 0;
    consumer.beforeAck = async () => {
      acked += 1;
      if (acked === 1) consumer.stop();
    };
    const received = await consumer.pollOnce();
    expect(received).toBeGreaterThanOrEqual(1);
    expect(acked).toBe(1);
    expect(await balanceOf(w.id)).toBe('990.00');

    // As demais voltam imediatamente (visibilidade 0): nada fica "preso" no timeout.
    const d = await depth(q, q.transactionsUrl);
    expect(d.inFlight).toBe(0);

    // Uma nova instância retoma e termina o trabalho.
    consumer.restart();
    consumer.beforeAck = undefined;
    await pollUntilIdle();
    expect(await balanceOf(w.id)).toBe('950.00');
    await expectLedgerConsistent(t, w.id);
  });
});

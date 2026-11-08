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
  submit,
  truncateAll,
  wagerRequest,
} from '../support/app';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(() => truncateAll(t.em()));

const sql = (query: string, params: unknown[] = []) =>
  t.em().getConnection().execute(query, params);

describe('POST /wallets', () => {
  test('cria wallet com saldo inicial: version 1, transação OPENING e lançamento CREDIT', async () => {
    const res = await http(t.baseUrl, 'POST', '/wallets', {
      body: { playerId: 'p-1', initialBalance: brl('100.00') },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      playerId: 'p-1',
      balance: brl('100.00'),
      version: 1,
    });

    const opening = await sql(
      `select kind, status from wager_transactions where wallet_id = ?`,
      [res.body.id],
    );
    expect(opening).toEqual([{ kind: 'OPENING', status: 'PROCESSED' }]);
    const ledger = await sql(
      `select direction, amount, balance_before, balance_after from wallet_ledger_entries`,
    );
    expect(ledger).toEqual([
      {
        direction: 'CREDIT',
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
      },
    ]);
    await expectLedgerConsistent(t, res.body.id);
  });

  test('saldo inicial zero: sem OPENING e sem ledger', async () => {
    const res = await http(t.baseUrl, 'POST', '/wallets', {
      body: { playerId: 'p-0', initialBalance: brl('0.00') },
    });
    expect(res.status).toBe(201);
    expect(
      await sql('select count(*)::int as n from wallet_ledger_entries'),
    ).toEqual([{ n: 0 }]);
  });

  test('mesmo playerId + moeda => 409, outra moeda é permitida', async () => {
    const body = { playerId: 'p-dup', initialBalance: brl('10.00') };
    expect((await http(t.baseUrl, 'POST', '/wallets', { body })).status).toBe(
      201,
    );
    const dup = await http(t.baseUrl, 'POST', '/wallets', { body });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    const usd = await http(t.baseUrl, 'POST', '/wallets', {
      body: {
        playerId: 'p-dup',
        initialBalance: { amount: '1.00', currency: 'USD' },
      },
    });
    expect(usd.status).toBe(201);
  });

  test.each([
    [{ playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    [{ playerId: 'p', initialBalance: { amount: '1.234', currency: 'BRL' } }],
    [{ playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
    [{ playerId: '', initialBalance: brl('1.00') }],
    [{ initialBalance: brl('1.00') }],
  ])('payload inválido => 400 (%p)', async (body) => {
    const res = await http(t.baseUrl, 'POST', '/wallets', { body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('consultas', () => {
  test('GET /wallets/:id e 404', async () => {
    const w = await createWallet(t, '5.00');
    const res = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: w.id,
      playerId: w.playerId,
      balance: brl('5.00'),
      version: 1,
    });
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${randomUUID()}`)).status,
    ).toBe(404);
    expect((await http(t.baseUrl, 'GET', `/wallets/nao-e-uuid`)).status).toBe(
      400,
    );
  });

  test('ledger com cursor opaco e estável', async () => {
    const w = await createWallet(t, '100.00');
    for (let i = 0; i < 4; i++) {
      await submit(t, wagerRequest(w, 'BET', '1.00'));
    }
    const first = await http(
      t.baseUrl,
      'GET',
      `/wallets/${w.id}/ledger?limit=2`,
    );
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeString();
    const second = await http(
      t.baseUrl,
      'GET',
      `/wallets/${w.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(2);
    const third = await http(
      t.baseUrl,
      'GET',
      `/wallets/${w.id}/ledger?limit=2&cursor=${second.body.nextCursor}`,
    );
    expect(third.body.items).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();

    const versions = [
      ...first.body.items,
      ...second.body.items,
      ...third.body.items,
    ].map((e: any) => e.walletVersion);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${w.id}/ledger?cursor=lixo`))
        .status,
    ).toBe(400);
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${w.id}/ledger?limit=0`)).status,
    ).toBe(400);
  });
});

describe('reconciliação', () => {
  test('wallet consistente', async () => {
    const w = await createWallet(t, '50.00');
    await submit(t, wagerRequest(w, 'BET', '20.00'));
    const res = await http(
      t.baseUrl,
      'POST',
      `/wallets/${w.id}/reconciliation`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: brl('30.00'),
      calculatedBalance: brl('30.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada e NÃO é corrigida', async () => {
    const w = await createWallet(t, '50.00');
    // Corrompe o saldo de propósito, direto no banco.
    await sql(`update wallets set balance = 60.00 where id = ?`, [w.id]);
    const res = await http(
      t.baseUrl,
      'POST',
      `/wallets/${w.id}/reconciliation`,
    );
    expect(res.body).toMatchObject({
      storedBalance: brl('60.00'),
      calculatedBalance: brl('50.00'),
      difference: brl('10.00'),
      consistent: false,
    });
    const after = await sql(`select balance from wallets where id = ?`, [w.id]);
    expect(after[0].balance).toBe('60.00'); // continua errado: nada foi corrigido em silêncio
  });
});

describe('health', () => {
  test('live e ready (Postgres e SQS)', async () => {
    expect((await http(t.baseUrl, 'GET', '/health/live')).body).toEqual({
      status: 'ok',
    });
    const ready = await http(t.baseUrl, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      status: 'ready',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });
});

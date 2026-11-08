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

describe('BET / WIN / LOSS via HTTP', () => {
  test('BET debita, WIN credita, LOSS não mexe no saldo', async () => {
    const w = await createWallet(t, '100.00');

    const bet = await submit(t, wagerRequest(w, 'BET', '30.00'));
    expect(bet.status).toBe(201);
    expect(bet.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('70.00'),
      idempotentReplay: false,
    });

    const win = await submit(t, wagerRequest(w, 'WIN', '50.00'));
    expect(win.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('120.00'),
    });

    const loss = await submit(t, wagerRequest(w, 'LOSS', '10.00'));
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('120.00'),
    });

    const entries = await sql(
      'select direction from wallet_ledger_entries order by wallet_version',
    );
    expect(entries.map((e: any) => e.direction)).toEqual([
      'CREDIT',
      'DEBIT',
      'CREDIT',
    ]); // LOSS não gera ledger
    const wallet = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
    expect(wallet.body.version).toBe(3); // LOSS não incrementa a versão
    await expectLedgerConsistent(t, w.id);
  });

  test('BET sem saldo => REJECTED / INSUFFICIENT_FUNDS, 422, sem ledger', async () => {
    const w = await createWallet(t, '10.00');
    const res = await submit(t, wagerRequest(w, 'BET', '10.01'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
    });
    expect(
      await sql('select count(*)::int as n from wallet_ledger_entries'),
    ).toEqual([{ n: 1 }]);
    await expectLedgerConsistent(t, w.id);
  });

  test('wallet inexistente => REJECTED / WALLET_NOT_FOUND e o replay devolve o mesmo resultado', async () => {
    const ghost = { id: randomUUID(), playerId: 'ghost' };
    const req = wagerRequest(ghost, 'BET', '1.00');
    const first = await submit(t, req);
    expect(first.status).toBe(422);
    expect(first.body.failureCode).toBe('WALLET_NOT_FOUND');
    const again = await submit(t, req);
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({
      transactionId: first.body.transactionId,
      idempotentReplay: true,
    });
  });

  test('moeda diferente da wallet => CURRENCY_MISMATCH', async () => {
    const w = await createWallet(t, '10.00');
    const req = wagerRequest(w, 'BET', '1.00', {
      money: { amount: '1.00', currency: 'USD' },
    });
    const res = await submit(t, req);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('player diferente do dono da wallet => WALLET_PLAYER_MISMATCH', async () => {
    const w = await createWallet(t, '10.00');
    const res = await submit(
      t,
      wagerRequest({ id: w.id, playerId: 'intruso' }, 'BET', '1.00'),
    );
    expect(res.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });
});

describe('idempotência', () => {
  test('mesma requisição => mesma resposta com idempotentReplay=true e NÃO debita de novo', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '40.00');
    const first = await submit(t, req);
    // outra bet muda o saldo atual, mas o replay devolve o saldo DAQUELE momento
    await submit(t, wagerRequest(w, 'BET', '10.00'));
    const replay = await submit(t, req);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('60.00'));
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where direction = 'DEBIT'`,
      ),
    ).toEqual([{ n: 2 }]);
  });

  test('mesma chave com payload diferente => 409 conflito (não é replay)', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '10.00');
    await submit(t, req);
    const conflict = await submit(t, {
      ...req,
      body: { ...(req.body as object), money: brl('11.00') },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const wallet = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
    expect(wallet.body.balance).toEqual(brl('90.00'));
  });

  test('a ordem das chaves e "10" vs "10.00" não mudam o payloadHash', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '10.00');
    await submit(t, req);
    const body = req.body as Record<string, unknown>;
    const reordered = Object.fromEntries(
      Object.entries({ ...body, money: brl('10') }).reverse(),
    );
    const replay = await submit(t, {
      body: reordered,
      idempotencyKey: req.idempotencyKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('mesmo externalTransactionId com outra Idempotency-Key => 409', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '10.00');
    await submit(t, req);
    const res = await submit(t, { ...req, idempotencyKey: 'outra-chave' });
    expect(res.status).toBe(409);
  });

  test('Idempotency-Key é obrigatória', async () => {
    const w = await createWallet(t);
    const req = wagerRequest(w, 'BET', '1.00');
    const res = await http(t.baseUrl, 'POST', '/wagering/transactions', {
      body: req.body,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('correlationId (metadado de transporte) não entra no hash', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '1.00');
    await submit(t, req, { 'x-correlation-id': 'a' });
    const replay = await submit(t, req, { 'x-correlation-id': 'b' });
    expect(replay.body.idempotentReplay).toBe(true);
  });
});

describe('validação do payload', () => {
  test.each([
    ['kind OPENING não pode ser submetido', { kind: 'OPENING' }],
    ['kind desconhecido', { kind: 'DEPOSIT' }],
    ['valor negativo', { money: brl('-1.00') }],
    ['valor zero', { money: brl('0.00') }],
    ['valor com 3 casas', { money: brl('1.001') }],
    ['valor em notação científica', { money: brl('1e2') }],
    ['valor number', { money: { amount: 1, currency: 'BRL' } }],
    ['walletId não UUID', { walletId: 'abc' }],
    ['providerId vazio', { providerId: '' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
  ])('%s => 400', async (_name, override) => {
    const w = await createWallet(t);
    const req = wagerRequest(
      w,
      'BET',
      '1.00',
      override as Record<string, unknown>,
    );
    const res = await submit(t, req);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('consultas de transação', () => {
  test('por id e por provider + externalTransactionId', async () => {
    const w = await createWallet(t);
    const req = wagerRequest(w, 'BET', '5.00');
    const created = await submit(t, req);
    const byId = await http(
      t.baseUrl,
      'GET',
      `/wagering/transactions/${created.body.transactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      kind: 'BET',
      status: 'PROCESSED',
      money: brl('5.00'),
    });
    const byExt = await http(
      t.baseUrl,
      'GET',
      `/providers/provider-1/wagering/transactions/${(req.body as any).externalTransactionId}`,
    );
    expect(byExt.body.transactionId).toBe(created.body.transactionId);
    expect(
      (await http(t.baseUrl, 'GET', `/wagering/transactions/${randomUUID()}`))
        .status,
    ).toBe(404);
    expect(
      (await http(t.baseUrl, 'GET', `/providers/x/wagering/transactions/y`))
        .status,
    ).toBe(404);
  });
});

describe('constraints do banco (a última linha de defesa)', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    const w = await createWallet(t, '10.00');
    await expect(
      sql(`update wallets set balance = -1 where id = ?`, [w.id]),
    ).rejects.toThrow();
  });

  test('wallet duplicada (player + moeda) é recusada pelo banco', async () => {
    const w = await createWallet(t, '10.00');
    await expect(
      sql(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', 0, 1, now(), now())`,
        [randomUUID(), w.playerId],
      ),
    ).rejects.toThrow();
  });

  test('ledger é imutável: UPDATE e DELETE são recusados', async () => {
    await createWallet(t, '10.00');
    await expect(
      sql(`update wallet_ledger_entries set amount = 1`),
    ).rejects.toThrow(/append-only/);
    await expect(sql(`delete from wallet_ledger_entries`)).rejects.toThrow(
      /append-only/,
    );
  });

  test('segundo lançamento para a mesma transação é recusado', async () => {
    const w = await createWallet(t, '100.00');
    const bet = await submit(t, wagerRequest(w, 'BET', '10.00'));
    await expect(
      sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
            balance_before, balance_after, wallet_version, created_at)
         values (?, ?, ?, 'DEBIT', 10, 'BRL', 90, 80, 99, now())`,
        [randomUUID(), w.id, bet.body.transactionId],
      ),
    ).rejects.toThrow(/uq_ledger_wallet_transaction/);
  });

  test('lançamento com aritmética errada é recusado', async () => {
    const w = await createWallet(t, '100.00');
    const bet = await submit(t, wagerRequest(w, 'BET', '10.00'));
    const other = await submit(t, wagerRequest(w, 'BET', '5.00'));
    await expect(
      sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
            balance_before, balance_after, wallet_version, created_at)
         values (?, ?, ?, 'DEBIT', 10, 'BRL', 90, 70, 99, now())`,
        [randomUUID(), w.id, other.body.transactionId],
      ),
    ).rejects.toThrow(/ck_ledger_balanced|uq_ledger/);
    expect(bet.status).toBe(201);
  });

  test('transação terminal não pode ser alterada nem apagada', async () => {
    const w = await createWallet(t, '10.00');
    const bet = await submit(t, wagerRequest(w, 'BET', '1.00'));
    await expect(
      sql(
        `update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?`,
        [bet.body.transactionId],
      ),
    ).rejects.toThrow(/already PROCESSED/);
    await expect(
      sql(`delete from wager_transactions where id = ?`, [
        bet.body.transactionId,
      ]),
    ).rejects.toThrow();
  });

  test('idempotency_key duplicada é recusada pelo banco', async () => {
    const w = await createWallet(t, '10.00');
    const bet = await submit(t, wagerRequest(w, 'BET', '1.00'));
    const [row] = await sql(
      `select idempotency_key from wager_transactions where id = ?`,
      [bet.body.transactionId],
    );
    await expect(
      sql(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency, status, pending_attempts, created_at)
         values (?, 'p', 'e-novo', ?, repeat('a', 64), ?, 'x', 'r', 'g', 'BET', 1, 'BRL', 'PENDING', 0, now())`,
        [randomUUID(), row.idempotency_key, w.id],
      ),
    ).rejects.toThrow(/uq_wager_tx_idempotency_key/);
  });
});

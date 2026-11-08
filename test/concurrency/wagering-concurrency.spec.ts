import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
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

describe('concorrência (paralelismo real: requisições HTTP simultâneas)', () => {
  test('saldo 100.00 e duas BETs de 80.00 ao mesmo tempo: uma PROCESSED, uma REJECTED, saldo 20.00', async () => {
    const w = await createWallet(t, '100.00');
    const [a, b] = await Promise.all([
      submit(t, wagerRequest(w, 'BET', '80.00')),
      submit(t, wagerRequest(w, 'BET', '80.00')),
    ]);

    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = a.body.status === 'REJECTED' ? a : b;
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.status).toBe(422);

    const wallet = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
    expect(wallet.body.balance).toEqual(brl('20.00'));
    // exatamente UM débito no ledger
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where direction = 'DEBIT'`,
      ),
    ).toEqual([{ n: 1 }]);
    await expectLedgerConsistent(t, w.id);
  });

  test('100/80 repetido em 25 wallets ao mesmo tempo (50 requisições simultâneas): sempre um vencedor por wallet', async () => {
    // Uma disputa de 2 requisições pode, por sorte, não se sobrepor. Com 50 simultâneas a sobreposição é certa.
    const wallets = await Promise.all(
      Array.from({ length: 25 }, () => createWallet(t, '100.00')),
    );
    const results = await Promise.all(
      wallets.flatMap((w) => [
        submit(t, wagerRequest(w, 'BET', '80.00')),
        submit(t, wagerRequest(w, 'BET', '80.00')),
      ]),
    );
    expect(results.every((r) => r.status === 201 || r.status === 422)).toBe(
      true,
    );
    for (const w of wallets) {
      const wallet = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
      expect(wallet.body.balance).toEqual(brl('20.00'));
      const txs = await sql(
        `select status, failure_code from wager_transactions where wallet_id = ? and kind = 'BET' order by status`,
        [w.id],
      );
      expect(txs).toEqual([
        { status: 'PROCESSED', failure_code: null },
        { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
      ]);
      expect(
        await sql(
          `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
          [w.id],
        ),
      ).toEqual([{ n: 1 }]);
    }
  });

  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await createWallet(t, '100.00');
    const req = wagerRequest(w, 'BET', '30.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(t, req)),
    );

    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(
      results.filter((r) => r.body.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      results.filter((r) => r.body.idempotentReplay === true),
    ).toHaveLength(49);
    // todos veem o mesmo saldo (o do momento da decisão)
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(
      new Set(['70.00']),
    );

    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${w.id}`)).body.balance,
    ).toEqual(brl('70.00'));
    expect(
      await sql(
        `select count(*)::int as n from wager_transactions where kind = 'BET'`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where direction = 'DEBIT'`,
      ),
    ).toEqual([{ n: 1 }]);
    await expectLedgerConsistent(t, w.id);
  });

  test('hot wallet: 60 apostas diferentes de 1.00 numa wallet com 40.00 => exatamente 40 passam', async () => {
    const w = await createWallet(t, '40.00');
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        submit(t, wagerRequest(w, 'BET', '1.00')),
      ),
    );
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(
      40,
    );
    expect(
      results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(20);
    expect(
      (await http(t.baseUrl, 'GET', `/wallets/${w.id}`)).body.balance,
    ).toEqual(brl('0.00'));
    await expectLedgerConsistent(t, w.id);
  });

  test('wallets distintas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(t, '100.00')),
    );
    const results = await Promise.all(
      wallets.flatMap((w) => [
        submit(t, wagerRequest(w, 'BET', '60.00')),
        submit(t, wagerRequest(w, 'BET', '60.00')),
      ]),
    );
    // por wallet: uma passa e a outra é rejeitada
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(
      10,
    );
    expect(results.filter((r) => r.body.status === 'REJECTED')).toHaveLength(
      10,
    );
    for (const w of wallets) {
      expect(
        (await http(t.baseUrl, 'GET', `/wallets/${w.id}`)).body.balance,
      ).toEqual(brl('40.00'));
      await expectLedgerConsistent(t, w.id);
    }
  });

  test('mistura de BET e WIN simultâneos mantém saldo == ledger', async () => {
    const w = await createWallet(t, '50.00');
    const ops = Array.from({ length: 40 }, (_, i) =>
      submit(t, wagerRequest(w, i % 2 === 0 ? 'BET' : 'WIN', '5.00')),
    );
    await Promise.all(ops);
    const summary = await http(
      t.baseUrl,
      'POST',
      `/wallets/${w.id}/reconciliation`,
    );
    expect(summary.body.consistent).toBe(true);
    const wallet = await http(t.baseUrl, 'GET', `/wallets/${w.id}`);
    // a versão sobe uma vez por mudança de saldo: abertura + processadas
    const processed = await sql(
      `select count(*)::int as n from wallet_ledger_entries`,
    );
    expect(wallet.body.version).toBe(processed[0].n);
  });
});

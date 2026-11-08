import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { PendingReferenceProcessor } from '../../src/wagering/application/pending-reference.processor';
import {
  TestApp,
  brl,
  createWallet,
  expectLedgerConsistent,
  startApp,
  submit,
  truncateAll,
  wagerRequest,
} from '../support/app';
import { eventually } from '../support/sqs';

let t: TestApp;
let pending: PendingReferenceProcessor;
beforeAll(async () => {
  t = await startApp();
  pending = t.app.get(PendingReferenceProcessor);
});
afterAll(() => t.close());
beforeEach(() => truncateAll(t.em()));

const sql = (query: string, params: unknown[] = []) =>
  t.em().getConnection().execute(query, params);

const outboxTypes = async () =>
  (await sql('select event_type from outbox_messages')).map(
    (r: any) => r.event_type,
  );

/** BET de 30 em uma wallet de 100; devolve a wallet e o id externo da BET. */
async function betScenario() {
  const w = await createWallet(t, '100.00');
  const bet = wagerRequest(w, 'BET', '30.00');
  expect((await submit(t, bet)).status).toBe(201);
  return { w, bet, ref: bet.body.externalTransactionId as string };
}

const reversal = (
  w: { id: string; playerId: string },
  kind: 'REFUND' | 'ROLLBACK',
  amount: string,
  ref: string,
  extra: Record<string, unknown> = {},
) =>
  wagerRequest(w, kind, amount, {
    referenceExternalTransactionId: ref,
    ...extra,
  });

describe('REFUND / ROLLBACK com a referência já processada', () => {
  test('REFUND devolve o valor da BET', async () => {
    const { w, ref } = await betScenario();
    const res = await submit(t, reversal(w, 'REFUND', '30.00', ref));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
    });
    await expectLedgerConsistent(t, w.id);
  });

  test('ROLLBACK de uma BET devolve; ROLLBACK de um WIN retira', async () => {
    const { w, ref } = await betScenario();
    const win = wagerRequest(w, 'WIN', '50.00');
    await submit(t, win);

    const undoBet = await submit(t, reversal(w, 'ROLLBACK', '30.00', ref));
    expect(undoBet.body).toMatchObject({ balance: brl('150.00') });

    const undoWin = await submit(
      t,
      reversal(w, 'ROLLBACK', '50.00', win.body.externalTransactionId),
    );
    expect(undoWin.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
    });
    await expectLedgerConsistent(t, w.id);
  });

  test('ROLLBACK de um REFUND é aceito (e REFUND de WIN não)', async () => {
    const { w, ref } = await betScenario();
    const refund = reversal(w, 'REFUND', '30.00', ref);
    await submit(t, refund);

    const undoRefund = await submit(
      t,
      reversal(w, 'ROLLBACK', '30.00', refund.body.externalTransactionId),
    );
    expect(undoRefund.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('70.00'),
    });

    const win = wagerRequest(w, 'WIN', '5.00');
    await submit(t, win);
    const badRefund = await submit(
      t,
      reversal(w, 'REFUND', '5.00', win.body.externalTransactionId),
    );
    expect(badRefund.status).toBe(422);
    expect(badRefund.body.failureCode).toBe('INVALID_REFERENCE_KIND');
    await expectLedgerConsistent(t, w.id);
  });

  test('sem referenceExternalTransactionId: 400 e nada é gravado', async () => {
    const { w } = await betScenario();
    const res = await submit(t, wagerRequest(w, 'REFUND', '30.00'));
    expect(res.status).toBe(400);
    expect(
      await sql(
        `select count(*)::int as n from wager_transactions where kind = 'REFUND'`,
      ),
    ).toEqual([{ n: 0 }]);
  });
});

describe('rejeições de negócio (422, com failureCode próprio)', () => {
  test('valor diferente do da referência: AMOUNT_MISMATCH', async () => {
    const { w, ref } = await betScenario();
    const res = await submit(t, reversal(w, 'REFUND', '10.00', ref));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'AMOUNT_MISMATCH',
    });
  });

  test('rodada diferente: REFERENCE_MISMATCH', async () => {
    const { w, ref } = await betScenario();
    const res = await submit(
      t,
      reversal(w, 'REFUND', '30.00', ref, { roundId: 'outra-rodada' }),
    );
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('segunda reversão da mesma referência: REFERENCE_ALREADY_REVERSED (e o índice único garante no banco)', async () => {
    const { w, ref } = await betScenario();
    expect((await submit(t, reversal(w, 'REFUND', '30.00', ref))).status).toBe(
      201,
    );
    const second = await submit(t, reversal(w, 'ROLLBACK', '30.00', ref));
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await sql(`select balance::text as b from wallets`))[0].b).toBe(
      '100.00',
    ); // não devolveu duas vezes

    // Mesmo que o código de aplicação falhasse, o banco recusa a segunda reversão processada.
    const [processed] = await sql(
      `select * from wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`,
    );
    await expect(
      sql(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
            player_id, round_id, game_id, kind, amount, currency, status,
            reference_external_transaction_id, reference_transaction_id, created_at, updated_at, processed_at)
         select gen_random_uuid(), provider_id, 'dup-direto', 'provider-1:dup-direto', payload_hash,
            wallet_id, player_id, round_id, game_id, 'ROLLBACK', amount, currency, status,
            reference_external_transaction_id, reference_transaction_id, created_at, updated_at, processed_at
         from wager_transactions where id = ?`,
        [processed.id],
      ),
    ).rejects.toThrow();
  });

  test('reversão que deixaria o saldo negativo: REVERSAL_WOULD_OVERDRAW, diferente de INSUFFICIENT_FUNDS', async () => {
    const w = await createWallet(t, '0.00');
    const win = wagerRequest(w, 'WIN', '50.00');
    await submit(t, win);
    // O jogador gasta o prêmio; desfazer o WIN agora deixaria o saldo negativo.
    await submit(t, wagerRequest(w, 'BET', '40.00'));

    const res = await submit(
      t,
      reversal(w, 'ROLLBACK', '50.00', win.body.externalTransactionId),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_WOULD_OVERDRAW',
    });
    expect((await sql(`select balance::text as b from wallets`))[0].b).toBe(
      '10.00',
    );

    const broke = await submit(t, wagerRequest(w, 'BET', '999.00'));
    expect(broke.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    await expectLedgerConsistent(t, w.id);
  });
});

describe('REFUND/ROLLBACK que chegam ANTES da referência (PENDING_REFERENCE)', () => {
  test('202, nenhum efeito financeiro e evento WagerTransactionPendingReference', async () => {
    const w = await createWallet(t, '100.00');
    await sql('delete from outbox_messages');
    const res = await submit(
      t,
      reversal(w, 'REFUND', '30.00', 'ainda-nao-chegou'),
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    expect(res.body.balance).toEqual(brl('100.00'));
    expect(await outboxTypes()).toEqual(['WagerTransactionPendingReference']);
    await expectLedgerConsistent(t, w.id);
  });

  test('entrega fora de ordem: a BET chega depois e o worker conclui a reversão', async () => {
    const w = await createWallet(t, '100.00');
    const bet = wagerRequest(w, 'BET', '30.00');
    const ref = bet.body.externalTransactionId as string;

    const early = reversal(w, 'REFUND', '30.00', ref);
    expect((await submit(t, early)).status).toBe(202);

    expect((await submit(t, bet)).status).toBe(201); // a referência finalmente chegou
    await eventually(async () => {
      await pending.runOnce();
      const [row] = await sql(
        `select status from wager_transactions where kind = 'REFUND'`,
      );
      if (row.status !== 'PROCESSED') throw new Error(row.status);
    });

    expect((await sql(`select balance::text as b from wallets`))[0].b).toBe(
      '100.00',
    ); // BET debitou 30 e o REFUND devolveu
    // reenviar o mesmo REFUND devolve o resultado final, sem novo efeito
    const replay = await submit(t, early);
    expect(replay.body).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: true,
    });
    expect(await outboxTypes()).toContain('WagerTransactionProcessed');
    await expectLedgerConsistent(t, w.id);
  });

  test('o worker respeita o backoff: tentativa antes da hora não conta', async () => {
    const w = await createWallet(t, '100.00');
    await submit(t, reversal(w, 'REFUND', '30.00', 'nunca-chega'));
    await sql(
      `update wager_transactions set next_attempt_at = now() + interval '1 hour' where kind = 'REFUND'`,
    );
    expect(await pending.runOnce()).toBe(0);
    expect(
      await sql(
        `select pending_attempts from wager_transactions where kind = 'REFUND'`,
      ),
    ).toEqual([{ pending_attempts: 0 }]);
  });

  test('referência que nunca chega: esgota as tentativas, vira REJECTED/REFERENCE_NOT_FOUND e publica o evento', async () => {
    const w = await createWallet(t, '100.00');
    const req = reversal(w, 'ROLLBACK', '30.00', 'nunca-chega');
    expect((await submit(t, req)).status).toBe(202);
    await sql('delete from outbox_messages');

    const attemptsSeen: number[] = [];
    await eventually(
      async () => {
        await pending.runOnce();
        const [row] = await sql(
          `select status, pending_attempts as a from wager_transactions where kind = 'ROLLBACK'`,
        );
        attemptsSeen.push(row.a);
        if (row.status !== 'REJECTED') throw new Error(`${row.status}`);
      },
      20_000,
      150,
    );

    const replay = await submit(t, req);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
    });
    expect(await outboxTypes()).toEqual(['WagerTransactionRejected']);
    // máximo de tentativas configurado nos testes (4): nunca passa disso
    expect(Math.max(...attemptsSeen)).toBeLessThanOrEqual(4);
    await expectLedgerConsistent(t, w.id);
  });

  test('vários workers ao mesmo tempo: a reversão é aplicada UMA vez', async () => {
    const w = await createWallet(t, '100.00');
    const bet = wagerRequest(w, 'BET', '30.00');
    await submit(
      t,
      reversal(w, 'REFUND', '30.00', bet.body.externalTransactionId),
    );
    await submit(t, bet);
    await sql(
      `update wager_transactions set next_attempt_at = now() where kind = 'REFUND'`,
    );

    await Promise.all(Array.from({ length: 5 }, () => pending.runOnce()));
    await eventually(async () => {
      await pending.runOnce();
      const [row] = await sql(
        `select status from wager_transactions where kind = 'REFUND'`,
      );
      if (row.status !== 'PROCESSED') throw new Error(row.status);
    });
    expect(
      await sql(
        `select count(*)::int as n from wallet_ledger_entries where direction = 'CREDIT' and wallet_version > 1`,
      ),
    ).toEqual([{ n: 1 }]);
    expect((await sql(`select balance::text as b from wallets`))[0].b).toBe(
      '100.00',
    );
    await expectLedgerConsistent(t, w.id);
  });
});

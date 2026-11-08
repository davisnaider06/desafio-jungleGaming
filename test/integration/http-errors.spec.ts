import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ConnectionException } from '@mikro-orm/core';
import { Database } from '../../src/persistence/database.service';
import {
  TestApp,
  createWallet,
  expectLedgerConsistent,
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

test('Postgres indisponível: 503 com Retry-After, nada gravado, e o retry do cliente funciona', async () => {
  const w = await createWallet(t, '100.00');
  const req = wagerRequest(w, 'BET', '10.00');

  const db = t.app.get(Database);
  const original = db.transaction.bind(db);
  db.transaction = (async () => {
    throw new ConnectionException(new Error('banco indisponível'));
  }) as typeof db.transaction;
  let res;
  try {
    res = await fetch(`${t.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': req.idempotencyKey,
      },
      body: JSON.stringify(req.body),
    });
  } finally {
    db.transaction = original;
  }
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).not.toBeNull();

  // O provedor reenvia com a MESMA chave e dá certo, uma única vez.
  expect((await submit(t, req)).status).toBe(201);
  expect((await submit(t, req)).status).toBe(200);
  await expectLedgerConsistent(t, w.id);
});

test('/metrics expõe contadores em texto Prometheus', async () => {
  const w = await createWallet(t, '100.00');
  const req = wagerRequest(w, 'BET', '10.00');
  await submit(t, req);
  await submit(t, req); // duplicata
  const text = await (await fetch(`${t.baseUrl}/metrics`)).text();
  // o registro de métricas é global ao processo de teste: confere o formato, não o valor exato
  expect(text).toMatch(
    /wager_transactions_total\{kind="BET",status="PROCESSED"\} \d+/,
  );
  expect(text).toContain('wager_duplicates_detected_total');
  expect(text).toContain('outbox_lag_seconds');
});

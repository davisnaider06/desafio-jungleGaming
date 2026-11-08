import { randomUUID } from 'node:crypto';
import { setDefaultTimeout } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';

// Os testes falam com Postgres e SQS reais; o padrão do Bun (5s) é curto demais.
setDefaultTimeout(120_000);

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  em: () => EntityManager;
  close: () => Promise<void>;
}

/** Sobe a aplicação NestJS de verdade (HTTP real, Postgres real) numa porta livre. */
export async function startApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.enableShutdownHooks();
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  const orm = app.get(MikroORM);
  return {
    app,
    baseUrl,
    em: () => orm.em.fork() as unknown as EntityManager,
    close: () => app.close(),
  };
}

/** Esvazia todas as tabelas (TRUNCATE ignora os triggers de linha, de propósito, só nos testes). */
export async function truncateAll(em: EntityManager): Promise<void> {
  await em
    .getConnection()
    .execute(
      'truncate table wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages cascade',
    );
}

export async function http(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function createWallet(
  t: TestApp,
  balance = '100.00',
  playerId = `player-${randomUUID()}`,
): Promise<{ id: string; playerId: string }> {
  const res = await http(t.baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: brl(balance) },
  });
  if (res.status !== 201)
    throw new Error(
      `createWallet failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  return { id: res.body.id, playerId };
}

let counter = 0;

/** Monta e envia uma transação. Por padrão a Idempotency-Key é "{providerId}:{externalTransactionId}". */
export function wagerRequest(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  const externalTransactionId =
    (extra.externalTransactionId as string) ??
    `ext-${randomUUID()}-${++counter}`;
  const body = {
    providerId: 'provider-1',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    ...extra,
  };
  return {
    body,
    idempotencyKey: `${body.providerId}:${body.externalTransactionId}`,
  };
}

export function submit(
  t: TestApp,
  req: { body: unknown; idempotencyKey: string },
  headers: Record<string, string> = {},
) {
  return http(t.baseUrl, 'POST', '/wagering/transactions', {
    body: req.body,
    headers: { 'idempotency-key': req.idempotencyKey, ...headers },
  });
}

/** Invariante final de TODOS os testes: saldo da wallet == saldo reconstruído pelo ledger. */
export async function expectLedgerConsistent(
  t: TestApp,
  walletId: string,
): Promise<void> {
  const res = await http(
    t.baseUrl,
    'POST',
    `/wallets/${walletId}/reconciliation`,
  );
  if (res.status !== 200 || res.body.consistent !== true) {
    throw new Error(`ledger inconsistent: ${JSON.stringify(res.body)}`);
  }
}

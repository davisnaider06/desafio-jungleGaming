import { EntitySchema } from '@mikro-orm/core';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from './records';

/**
 * Mapeamento das tabelas. Aqui moram as GARANTIAS do banco (checks e índices únicos):
 * mesmo que o código tenha um bug, o Postgres recusa dados que violam as invariantes.
 *
 * Dinheiro: NUMERIC(20,2) + moeda CHAR(3). O driver devolve NUMERIC como string,
 * então nunca passa por `number`.
 */
const money = { type: 'string', columnType: 'numeric(20,2)' } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', length: 64 },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  // No máximo uma wallet por jogador e moeda.
  uniques: [
    {
      name: 'uq_wallets_player_currency',
      properties: ['playerId', 'currency'],
    },
  ],
  // Saldo nunca negativo e versão começa em 1.
  checks: [
    { name: 'ck_wallets_balance_non_negative', expression: 'balance >= 0' },
    { name: 'ck_wallets_version_positive', expression: 'version >= 1' },
  ],
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 64 },
    externalTransactionId: { type: 'string', length: 128 },
    idempotencyKey: { type: 'string', length: 256 },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    // Sem FK de propósito: precisamos gravar REJECTED/WALLET_NOT_FOUND para
    // que o replay devolva o mesmo resultado. Ver ARCHITECTURE.md.
    walletId: { type: 'uuid' },
    playerId: { type: 'string', length: 64 },
    roundId: { type: 'string', length: 128 },
    gameId: { type: 'string', length: 128 },
    kind: { type: 'string', length: 16 },
    amount: money,
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      length: 128,
      nullable: true,
    },
    // FK para a própria tabela: a transação que esta reverte/referencia (só preenchida quando PROCESSED).
    referenceTransactionId: {
      kind: 'm:1',
      entity: (() => WagerTransactionRecord) as never,
      mapToPk: true,
      nullable: true,
      fieldName: 'reference_transaction_id',
    },
    status: { type: 'string', length: 24 },
    failureCode: { type: 'string', length: 48, nullable: true },
    balanceSnapshot: { ...money, nullable: true },
    pendingAttempts: { type: 'integer', default: 0 },
    nextAttemptAt: { ...timestamp, nullable: true },
    createdAt: timestamp,
    processedAt: { ...timestamp, nullable: true },
  },
  uniques: [
    // IDEMPOTÊNCIA: a mesma chave nunca cria duas transações.
    { name: 'uq_wager_tx_idempotency_key', properties: ['idempotencyKey'] },
    // Um mesmo id do provedor nunca vira duas transações (nem com chaves diferentes).
    {
      name: 'uq_wager_tx_provider_external',
      properties: ['providerId', 'externalTransactionId'],
    },
    // Uma referência só pode ser revertida UMA vez (por REFUND ou ROLLBACK). Índice único parcial.
    {
      name: 'uq_wager_tx_single_reversal',
      properties: ['referenceTransactionId'],
      where: "kind in ('REFUND', 'ROLLBACK')",
    },
  ],
  indexes: [
    // Worker de PENDING_REFERENCE: só olha as linhas pendentes, por horário.
    {
      name: 'ix_wager_tx_pending_reference_due',
      properties: ['nextAttemptAt'],
      where: "status = 'PENDING_REFERENCE'",
    },
    { name: 'ix_wager_tx_wallet', properties: ['walletId', 'createdAt'] },
    // Resolver referências: (provider, externalId) já é único; round ajuda consultas por rodada.
    { name: 'ix_wager_tx_round', properties: ['providerId', 'roundId'] },
  ],
  checks: [
    {
      name: 'ck_wager_tx_kind',
      expression: "kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')",
    },
    {
      name: 'ck_wager_tx_status',
      expression:
        "status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')",
    },
    { name: 'ck_wager_tx_amount_positive', expression: 'amount > 0' },
    {
      name: 'ck_wager_tx_reversal_needs_reference',
      expression:
        "kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null",
    },
    {
      name: 'ck_wager_tx_rejected_has_code',
      expression:
        "status not in ('REJECTED','FAILED') or failure_code is not null",
    },
    {
      name: 'ck_wager_tx_processed_has_date',
      expression:
        "status not in ('PROCESSED','REJECTED','FAILED') or processed_at is not null",
    },
  ],
});

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: 'wallet_ledger_entries',
    properties: {
      id: { type: 'uuid', primary: true },
      // FKs: não existe lançamento sem wallet nem sem transação. (mapToPk: o valor é só o id.)
      walletId: {
        kind: 'm:1',
        entity: (() => WalletRecord) as never,
        mapToPk: true,
        fieldName: 'wallet_id',
      },
      transactionId: {
        kind: 'm:1',
        entity: (() => WagerTransactionRecord) as never,
        mapToPk: true,
        fieldName: 'transaction_id',
      },
      direction: { type: 'string', length: 6 },
      amount: money,
      currency: { type: 'string', columnType: 'char(3)' },
      balanceBefore: money,
      balanceAfter: money,
      walletVersion: { type: 'integer' },
      createdAt: timestamp,
    },
    uniques: [
      // No máximo um lançamento por transação por wallet: um retry nunca duplica o débito.
      {
        name: 'uq_ledger_wallet_transaction',
        properties: ['walletId', 'transactionId'],
      },
      // A versão da wallet é única por lançamento: dá a ordem do extrato e detecta lost update.
      {
        name: 'uq_ledger_wallet_version',
        properties: ['walletId', 'walletVersion'],
      },
    ],
    checks: [
      {
        name: 'ck_ledger_direction',
        expression: "direction in ('DEBIT','CREDIT')",
      },
      { name: 'ck_ledger_amount_positive', expression: 'amount > 0' },
      {
        name: 'ck_ledger_balances_non_negative',
        expression: 'balance_before >= 0 and balance_after >= 0',
      },
      {
        // O ledger se auto-audita: antes ± valor = depois.
        name: 'ck_ledger_balanced',
        expression:
          "(direction = 'CREDIT' and balance_before + amount = balance_after) or (direction = 'DEBIT' and balance_before - amount = balance_after)",
      },
    ],
  });

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 128, primary: true },
    messageId: { type: 'string', length: 128, primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: timestamp,
    processedAt: { ...timestamp, nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', length: 64 },
    eventType: { type: 'string', length: 64 },
    payload: { type: 'json' },
    occurredAt: timestamp,
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: timestamp,
    publishedAt: { ...timestamp, nullable: true },
  },
  indexes: [
    // O publisher só varre o que ainda não foi publicado.
    {
      name: 'ix_outbox_unpublished',
      properties: ['nextAttemptAt'],
      where: 'published_at is null',
    },
  ],
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

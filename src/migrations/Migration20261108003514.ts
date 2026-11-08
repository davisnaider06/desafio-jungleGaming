import { Migration } from '@mikro-orm/migrations';

export class Migration20261108003514 extends Migration {
  override name = 'Migration20261108003514';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "inbox_messages" ("consumer_name" varchar(128) not null, "message_id" varchar(128) not null, "payload_hash" char(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`,
    );

    this.addSql(
      `create table "outbox_messages" ("id" uuid not null, "aggregate_id" varchar(64) not null, "event_type" varchar(64) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null, "published_at" timestamptz null, primary key ("id"));`,
    );
    this.addSql(
      `create index "ix_outbox_unpublished" on "outbox_messages" ("next_attempt_at") where published_at is null;`,
    );

    this.addSql(
      `create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(64) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(256) not null, "payload_hash" char(64) not null, "wallet_id" uuid not null, "player_id" varchar(64) not null, "round_id" varchar(128) not null, "game_id" varchar(128) not null, "kind" varchar(16) not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "status" varchar(24) not null, "failure_code" varchar(48) null, "balance_snapshot" numeric(20,2) null, "pending_attempts" int not null default 0, "next_attempt_at" timestamptz null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`,
    );
    this.addSql(
      `create index "ix_wager_tx_pending_reference_due" on "wager_transactions" ("next_attempt_at") where status = 'PENDING_REFERENCE';`,
    );
    this.addSql(
      `create index "ix_wager_tx_wallet" on "wager_transactions" ("wallet_id", "created_at");`,
    );
    this.addSql(
      `create index "ix_wager_tx_round" on "wager_transactions" ("provider_id", "round_id");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "uq_wager_tx_idempotency_key" unique ("idempotency_key");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "uq_wager_tx_provider_external" unique ("provider_id", "external_transaction_id");`,
    );
    this.addSql(
      `create unique index "uq_wager_tx_single_reversal" on "wager_transactions" ("reference_transaction_id") where kind in ('REFUND', 'ROLLBACK');`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_kind" check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_status" check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_amount_positive" check (amount > 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_reversal_needs_reference" check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_rejected_has_code" check (status not in ('REJECTED','FAILED') or failure_code is not null);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_processed_has_date" check (status not in ('PROCESSED','REJECTED','FAILED') or processed_at is not null);`,
    );

    this.addSql(
      `create table "wallets" ("id" uuid not null, "player_id" varchar(64) not null, "currency" char(3) not null, "balance" numeric(20,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallets" add constraint "uq_wallets_player_currency" unique ("player_id", "currency");`,
    );
    this.addSql(
      `alter table "wallets" add constraint "ck_wallets_balance_non_negative" check (balance >= 0);`,
    );
    this.addSql(
      `alter table "wallets" add constraint "ck_wallets_version_positive" check (version >= 1);`,
    );

    this.addSql(
      `create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "wallet_version" int not null, "created_at" timestamptz not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "uq_ledger_wallet_transaction" unique ("wallet_id", "transaction_id");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "uq_ledger_wallet_version" unique ("wallet_id", "wallet_version");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "ck_ledger_direction" check (direction in ('DEBIT','CREDIT'));`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "ck_ledger_amount_positive" check (amount > 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "ck_ledger_balances_non_negative" check (balance_before >= 0 and balance_after >= 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "ck_ledger_balanced" check ((direction = 'CREDIT' and balance_before + amount = balance_after) or (direction = 'DEBIT' and balance_before - amount = balance_after));`,
    );

    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete set null;`,
    );

    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`,
    );
  }

  // O CLI gera só o `up`; o `down` desfaz tudo na ordem inversa das dependências.
  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
  }
}

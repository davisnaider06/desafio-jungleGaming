import { Migration } from '@mikro-orm/migrations';

/**
 * Imutabilidade garantida pelo banco (o schema declarativo não expressa isso):
 *  - o ledger é append-only: nenhum UPDATE nem DELETE;
 *  - uma transação em estado terminal (PROCESSED/REJECTED/FAILED) não muda mais;
 *  - os dados de negócio de uma transação nunca mudam; transações nunca são apagadas.
 */
export class Migration20261108003531 extends Migration {
  override name = 'Migration20261108003531';

  override up(): void | Promise<void> {
    this.addSql(`
      create function forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% not allowed)', tg_op
          using errcode = 'restrict_violation';
      end $$;
    `);
    this.addSql(`
      create trigger trg_ledger_append_only
        before update or delete on "wallet_ledger_entries"
        for each row execute function forbid_ledger_mutation();
    `);

    this.addSql(`
      create function guard_wager_transaction() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is already % and cannot change', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if new.id <> old.id
          or new.idempotency_key <> old.idempotency_key
          or new.payload_hash <> old.payload_hash
          or new.provider_id <> old.provider_id
          or new.external_transaction_id <> old.external_transaction_id
          or new.wallet_id <> old.wallet_id
          or new.kind <> old.kind
          or new.amount <> old.amount
          or new.currency <> old.currency then
          raise exception 'business columns of wager transaction % are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger trg_wager_transaction_guard
        before update or delete on "wager_transactions"
        for each row execute function guard_wager_transaction();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `drop trigger if exists trg_wager_transaction_guard on "wager_transactions";`,
    );
    this.addSql(`drop function if exists guard_wager_transaction();`);
    this.addSql(
      `drop trigger if exists trg_ledger_append_only on "wallet_ledger_entries";`,
    );
    this.addSql(`drop function if exists forbid_ledger_mutation();`);
  }
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../../src/config';
import { ALL_SCHEMAS } from '../../src/persistence/schemas';
import { MIGRATIONS_LIST } from '../support/migrations-list';

const SCRATCH_DB = 'wagering_migrations_scratch';
const { db } = loadConfig();

let orm: MikroORM;

const tables = async () =>
  (
    await orm.em.getConnection().execute<{ table_name: string }[]>(
      `select table_name from information_schema.tables
          where table_schema = 'public' and table_name not like 'mikro_orm%' order by 1`,
    )
  ).map((r) => r.table_name);

beforeAll(async () => {
  const admin = await MikroORM.init({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    dbName: 'postgres',
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  const conn = admin.em.getConnection();
  await conn.execute(`drop database if exists ${SCRATCH_DB}`);
  await conn.execute(`create database ${SCRATCH_DB}`);
  await admin.close();

  orm = await MikroORM.init({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    dbName: SCRATCH_DB,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    migrations: { migrationsList: MIGRATIONS_LIST, snapshot: false },
  });
});

afterAll(() => orm.close());

describe('migrations reversíveis', () => {
  test('up cria o schema, down remove tudo e up recria', async () => {
    await orm.migrator.up();
    const created = await tables();
    expect(created).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    // down de TODAS as migrations (uma por vez, da mais nova para a mais antiga)
    for (let i = 0; i < MIGRATIONS_LIST.length; i++) await orm.migrator.down();
    expect(await tables()).toEqual([]);
    const functions = await orm.em
      .getConnection()
      .execute(
        `select proname from pg_proc where proname in ('forbid_ledger_mutation', 'guard_wager_transaction')`,
      );
    expect(functions).toEqual([]);

    await orm.migrator.up();
    expect(await tables()).toEqual(created);
  });

  test('o schema do banco bate com as entidades (nenhuma migration pendente)', async () => {
    const diff = await orm.schema.getUpdateSchemaSQL({ safe: true });
    // Os triggers/funções não aparecem no diff; tabelas, colunas, índices e constraints sim.
    expect(diff.trim()).toBe('');
  });
});

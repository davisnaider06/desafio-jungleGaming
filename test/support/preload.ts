import { randomBytes } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

/**
 * Preload dos testes. IMPORTANTE: as variáveis de ambiente são definidas ANTES de qualquer
 * import do app, porque a configuração é lida na hora do import.
 *
 * - Banco: `wagering_test` (separado do banco de desenvolvimento), criado se não existir.
 * - Filas: nomes com sufixo aleatório por execução, para uma execução não enxergar mensagens de outra.
 * - Workers em segundo plano ficam desligados; cada teste liga só o que precisa.
 */
const suffix = randomBytes(3).toString('hex');

Object.assign(process.env, {
  DB_NAME: 'wagering_test',
  SQS_TRANSACTIONS_QUEUE: `t-${suffix}-wager-transactions.fifo`,
  SQS_TRANSACTIONS_DLQ: `t-${suffix}-wager-transactions-dlq.fifo`,
  SQS_EVENTS_QUEUE: `t-${suffix}-wager-events.fifo`,
  OUTBOX_WORKER: 'off',
  SQS_CONSUMER: 'off',
  PENDING_WORKER: 'off',
  SQS_WAIT_SECONDS: '1',
  SQS_MAX_RECEIVE_COUNT: '3',
  SQS_VISIBILITY_TIMEOUT: '2',
  PENDING_BASE_DELAY_MS: '100',
  PENDING_MAX_DELAY_MS: '400',
  PENDING_MAX_ATTEMPTS: '4',
  OUTBOX_BASE_DELAY_MS: '50',
  OUTBOX_MAX_DELAY_MS: '200',
});

const { db } = (await import('../../src/config')).loadConfig();
const { ALL_SCHEMAS } = await import('../../src/persistence/schemas');
const { MIGRATIONS_LIST } = await import('./migrations-list');

async function admin<T>(fn: (orm: MikroORM) => Promise<T>): Promise<T> {
  const orm = await MikroORM.init({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    dbName: 'postgres',
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  try {
    return await fn(orm);
  } finally {
    await orm.close();
  }
}

await admin(async (orm) => {
  const exists = await orm.em
    .getConnection()
    .execute(`select 1 from pg_database where datname = ?`, [db.name]);
  if (exists.length === 0)
    await orm.em.getConnection().execute(`create database ${db.name}`);
});

// Aplica as migrations reais (o mesmo caminho de produção).
const orm = await MikroORM.init({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  dbName: db.name,
  entities: ALL_SCHEMAS,
  extensions: [Migrator],
  migrations: { migrationsList: MIGRATIONS_LIST, snapshot: false },
  forceUtcTimezone: true,
});
await orm.migrator.up();
await orm.close();

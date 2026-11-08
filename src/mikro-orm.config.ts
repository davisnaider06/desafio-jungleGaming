import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from './config';
import { ALL_SCHEMAS } from './persistence/schemas';

const { db } = loadConfig();

export default defineConfig({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  dbName: db.name,
  entities: ALL_SCHEMAS,
  extensions: [Migrator],
  migrations: {
    path: 'src/migrations',
    pathTs: 'src/migrations',
    // Migrations geradas já com up e down.
    snapshot: true,
    transactional: true,
  },
  forceUtcTimezone: true,
  debug: process.env.MIKRO_ORM_DEBUG === 'true',
});

import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
host: 'localhost',
port: 5432,
user: 'wagering',
password: 'wagering',
dbName: 'wagering',
entities: ['dist/**/*.entity.js'],
entitiesTs: ['src/**/*.entity.ts'],
discovery: { warnWhenNoEntities: false },
extensions: [Migrator],
migrations: { path: 'dist/migrations', pathTs: 'src/migrations' },
debug: true,
});
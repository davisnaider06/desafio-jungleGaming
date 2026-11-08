import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Lista explícita das migrations para os testes (o Bun carrega os .ts direto, sem passar por glob de pasta).
 * Lê todos os arquivos de src/migrations, então novas migrations entram sozinhas.
 */
const dir = path.resolve(import.meta.dir, '../../src/migrations');

export const MIGRATIONS_LIST: { name: string; class: any }[] = fs
  .readdirSync(dir)
  .filter((f) => /^Migration\d+\.ts$/.test(f))
  .sort()
  .map((file) => {
    const name = file.replace(/\.ts$/, '');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path.join(dir, file));
    return { name, class: mod[name] };
  });

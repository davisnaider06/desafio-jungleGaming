/**
 * Painel "Prova de Fogo" — servidor local.
 *
 * - Serve o index.html em http://localhost:4000
 * - Repassa /api/* para a API do desafio (evita problema de CORS no navegador)
 * - Expõe /ops/* com AÇÕES FIXAS de infraestrutura (derrubar/subir Postgres, mandar
 *   mensagem na fila). Só comandos pré-definidos, nada vindo do navegador vira comando.
 *
 * Uso (na raiz do projeto): bun run fogo
 * Por padrão usa a raiz do projeto (dois níveis acima) como pasta do docker-compose.yml;
 * COMPOSE_DIR e API_URL podem sobrescrever.
 */

import { resolve } from 'node:path';

const PORT = Number(process.env.PANEL_PORT ?? 4000);
const API = process.env.API_URL ?? 'http://localhost:3000';
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? resolve(import.meta.dir, '..', '..');

async function run(args: string[]): Promise<{ code: number; out: string }> {
  if (!COMPOSE_DIR) {
    return { code: 1, out: 'Defina COMPOSE_DIR com a pasta do docker-compose.yml do desafio.' };
  }
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    cwd: COMPOSE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: (out + err).trim() };
}

async function queueUrl(): Promise<string> {
  const r = await run([
    'exec', '-T', 'ministack', 'awslocal', 'sqs', 'get-queue-url',
    '--queue-name', 'wager-transactions.fifo',
  ]);
  if (r.code !== 0) throw new Error(r.out);
  return JSON.parse(r.out).QueueUrl as string;
}

const ops: Record<string, (body: any) => Promise<unknown>> = {
  'postgres-stop': () => run(['stop', 'postgres']),
  'postgres-start': () => run(['start', 'postgres']),
  'queue-send': async (body) => {
    // body = { envelope, groupId, dedupId }
    const url = await queueUrl();
    return run([
      'exec', '-T', 'ministack', 'awslocal', 'sqs', 'send-message',
      '--queue-url', url,
      '--message-body', JSON.stringify(body.envelope),
      '--message-group-id', String(body.groupId),
      '--message-deduplication-id', String(body.dedupId),
    ]);
  },
};

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1', // só acessível na própria máquina
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(new URL('./index.html', import.meta.url)));
    }

    if (url.pathname.startsWith('/api/')) {
      const target = API + url.pathname.slice(4) + url.search;
      const headers = new Headers();
      for (const h of ['content-type', 'idempotency-key', 'x-correlation-id']) {
        const v = req.headers.get(h);
        if (v !== null) headers.set(h, v);
      }
      try {
        const res = await fetch(target, {
          method: req.method,
          headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text(),
        });
        return new Response(await res.text(), {
          status: res.status,
          headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
        });
      } catch (e) {
        return Response.json({ panelError: 'API fora do ar', detail: String(e) }, { status: 599 });
      }
    }

    if (url.pathname.startsWith('/ops/') && req.method === 'POST') {
      const name = url.pathname.slice(5);
      const op = ops[name];
      if (!op) return Response.json({ error: 'ação desconhecida' }, { status: 404 });
      try {
        const body = await req.json().catch(() => ({}));
        return Response.json(await op(body));
      } catch (e) {
        return Response.json({ code: 1, out: String(e) }, { status: 500 });
      }
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`Prova de Fogo em http://localhost:${PORT}  (API: ${API})`);
if (!COMPOSE_DIR) console.log('Aviso: COMPOSE_DIR não definido — os testes de infraestrutura ficam desligados.');

import { createServer } from 'node:net';
import { eventually } from './sqs';

export interface Instance {
  port: number;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** kill -9: o processo some sem chance de limpar nada. */
  kill(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Sobe UM processo real do serviço (`bun src/main.ts`), com seus próprios workers.
 * Todos os processos usam o mesmo Postgres e as mesmas filas: é o cenário de produção com várias instâncias.
 */
export async function startInstance(
  env: Record<string, string> = {},
): Promise<Instance> {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: 'error',
      OUTBOX_WORKER: 'on',
      SQS_CONSUMER: 'on',
      PENDING_WORKER: 'on',
      OUTBOX_INTERVAL_MS: '200',
      PENDING_INTERVAL_MS: '200',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const baseUrl = `http://localhost:${port}`;
  await eventually(
    async () => {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.status !== 200) throw new Error(`not ready: ${res.status}`);
    },
    40_000,
    250,
  );

  return {
    port,
    baseUrl,
    proc,
    async kill() {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}

export async function startInstances(
  count: number,
  env: Record<string, string> = {},
): Promise<Instance[]> {
  return Promise.all(Array.from({ length: count }, () => startInstance(env)));
}

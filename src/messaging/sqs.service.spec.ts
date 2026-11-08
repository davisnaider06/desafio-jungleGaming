import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { waitForSqs } from './sqs.service';

/** Cliente falso: falha as primeiras `failures` chamadas com "socket hang up". */
function fakeClient(failures: number) {
  let calls = 0;
  const client = {
    send: async () => {
      calls += 1;
      if (calls <= failures) throw new Error('socket hang up');
      return {};
    },
  } as unknown as SQSClient;
  return { client, calls: () => calls };
}

describe('waitForSqs', () => {
  test('responde de primeira: não espera nem repete', async () => {
    const { client, calls } = fakeClient(0);
    await waitForSqs(client, { initialDelayMs: 1 });
    expect(calls()).toBe(1);
  });

  test('tenta de novo com backoff até o SQS responder', async () => {
    const { client, calls } = fakeClient(3);
    const delays: number[] = [];
    await waitForSqs(client, {
      initialDelayMs: 5,
      maxDelayMs: 20,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    });
    expect(calls()).toBe(4);
    expect(delays).toEqual([5, 10, 20]);
  });

  test('esgotou o tempo: erro claro com tentativas e último erro', async () => {
    const { client } = fakeClient(Number.POSITIVE_INFINITY);
    const started = Date.now();
    const error = await waitForSqs(client, {
      timeoutMs: 80,
      initialDelayMs: 10,
      maxDelayMs: 20,
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('SQS não ficou disponível');
    expect((error as Error).message).toContain('socket hang up');
    expect((error as Error).message).toContain('docker compose up -d --wait');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

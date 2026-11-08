import { describe, expect, test } from 'bun:test';
import { backoffDelayMs, BackgroundLoop } from './background-loop';

describe('backoffDelayMs', () => {
  test('sem falhas usa o intervalo normal', () => {
    expect(backoffDelayMs(50, 0, 30_000)).toBe(50);
  });

  test('1ª falha mantém o intervalo; depois dobra até o teto', () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      backoffDelayMs(100, n, 500),
    );
    expect(seq).toEqual([100, 200, 400, 500, 500, 500, 500, 500]);
  });

  test('nunca fica abaixo do intervalo, mesmo com teto menor', () => {
    expect(backoffDelayMs(1000, 5, 300)).toBe(1000);
  });

  test('número enorme de falhas não estoura', () => {
    expect(backoffDelayMs(50, 10_000, 30_000)).toBe(30_000);
  });
});

describe('BackgroundLoop', () => {
  /** Roda o loop com timers reais e pequenos; `script` diz se cada tick falha (true) ou passa. */
  async function runScripted(script: boolean[], interval = 2, max = 16) {
    const delays: number[] = []; // atraso que valia ANTES de cada tick
    const failures: { error: unknown; nextDelayMs: number }[] = [];
    const recoveries: number[] = [];
    let calls = 0;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));

    const loop: BackgroundLoop = new BackgroundLoop(
      'teste',
      async () => {
        const shouldFail = script[calls] ?? false;
        delays.push(loop.currentDelayMs);
        calls += 1;
        if (calls >= script.length) setTimeout(done, 0);
        if (shouldFail) throw new Error(`falha ${calls}`);
      },
      interval,
      {
        onFailure: (_n, error, { nextDelayMs }) =>
          failures.push({ error, nextDelayMs }),
        onRecovered: (_n, { failures: f }) => recoveries.push(f),
      },
      max,
    );
    loop.start();
    await finished;
    const delayAfterLast = loop.currentDelayMs;
    await loop.stop();
    return { delays, failures, recoveries, calls, delayAfterLast, loop };
  }

  test('erros seguidos dobram o atraso até o teto', async () => {
    const r = await runScripted([true, true, true, true, true, true]);
    // atraso vigente ao iniciar cada tick: normal (0 falhas), 2 (1ª falha mantém o
    // intervalo), depois dobra: 4, 8, 16 e fica no teto
    expect(r.delays).toEqual([2, 2, 4, 8, 16, 16]);
    expect(r.delayAfterLast).toBe(16);
    expect(r.loop.consecutiveFailures).toBe(6);
  });

  test('loga só ao entrar em falha, com o próximo atraso', async () => {
    const r = await runScripted([true, true, true, true]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].nextDelayMs).toBe(2);
    expect((r.failures[0].error as Error).message).toBe('falha 1');
    expect(r.recoveries).toHaveLength(0);
  });

  test('o primeiro sucesso volta ao intervalo normal e loga a recuperação', async () => {
    const r = await runScripted([true, true, true, false]);
    expect(r.recoveries).toEqual([3]);
    expect(r.delayAfterLast).toBe(2);
    expect(r.loop.consecutiveFailures).toBe(0);
  });

  test('nova falha depois de recuperar volta a logar', async () => {
    const r = await runScripted([true, false, true, true, false]);
    expect(r.failures).toHaveLength(2);
    expect(r.recoveries).toEqual([1, 2]);
  });

  test('sem erros nunca chama os hooks', async () => {
    const r = await runScripted([false, false, false]);
    expect(r.failures).toHaveLength(0);
    expect(r.recoveries).toHaveLength(0);
    expect(r.delays).toEqual([2, 2, 2]);
  });

  test('stop() espera o tick em andamento e não agenda mais nada', async () => {
    let finishedTick = false;
    const loop = new BackgroundLoop(
      'lento',
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        finishedTick = true;
      },
      1,
      { onFailure: () => {}, onRecovered: () => {} },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 10));
    await loop.stop();
    expect(finishedTick).toBe(true);
  });
});

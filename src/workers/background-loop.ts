/** Teto do atraso entre tentativas quando o tick falha várias vezes seguidas. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface BackgroundLoopHooks {
  /**
   * Chamado UMA vez ao entrar em falha (primeiro erro depois de um sucesso).
   * Erros seguintes da mesma sequência não chamam de novo: evita uma enxurrada de logs.
   */
  onFailure: (
    name: string,
    error: unknown,
    info: { nextDelayMs: number },
  ) => void;
  /** Chamado no primeiro sucesso depois de uma sequência de falhas. */
  onRecovered: (name: string, info: { failures: number }) => void;
}

/**
 * Atraso antes da próxima tentativa: o intervalo normal na 1ª falha, dobrando a cada falha
 * seguida, até o teto. Sem falhas, é o intervalo normal.
 */
export function backoffDelayMs(
  intervalMs: number,
  consecutiveFailures: number,
  maxBackoffMs: number,
): number {
  if (consecutiveFailures <= 0) return intervalMs;
  const ceiling = Math.max(intervalMs, maxBackoffMs);
  const exponent = Math.min(consecutiveFailures - 1, 30); // evita estourar a potência
  return Math.min(ceiling, intervalMs * 2 ** exponent);
}

/**
 * Executa `tick` repetidamente, sem sobreposição (um tick só começa quando o anterior termina).
 * `stop()` espera o tick em andamento acabar: é o que dá o desligamento limpo no SIGTERM.
 *
 * Em erros consecutivos o atraso dobra até `maxBackoffMs`; no primeiro sucesso volta ao
 * intervalo normal. Foi o que faltou quando a fila não existia: o loop tentava a cada ~60 ms.
 */
export class BackgroundLoop {
  private running = false;
  private stopping = false;
  private current: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly hooks: BackgroundLoopHooks,
    private readonly maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.schedule(0);
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Falhas seguidas até agora (0 = saudável). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Atraso que será usado antes do próximo tick. */
  get currentDelayMs(): number {
    return backoffDelayMs(this.intervalMs, this.failures, this.maxBackoffMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
    this.running = false;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.current = this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    try {
      await this.tick();
      if (this.failures > 0) {
        const failures = this.failures;
        this.failures = 0;
        this.hooks.onRecovered(this.name, { failures });
      }
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1) {
        this.hooks.onFailure(this.name, error, {
          nextDelayMs: this.currentDelayMs,
        });
      }
    }
    if (!this.stopping) this.schedule(this.currentDelayMs);
  }
}

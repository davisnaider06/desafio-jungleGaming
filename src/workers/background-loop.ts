/**
 * Executa `tick` repetidamente, sem sobreposição (um tick só começa quando o anterior termina).
 * `stop()` espera o tick em andamento acabar: é o que dá o desligamento limpo no SIGTERM.
 */
export class BackgroundLoop {
  private running = false;
  private stopping = false;
  private current: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (name: string, error: unknown) => void,
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
    } catch (error) {
      this.onError(this.name, error);
    }
    if (!this.stopping) this.schedule(this.intervalMs);
  }
}

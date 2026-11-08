/**
 * Métricas em memória no formato texto do Prometheus (GET /metrics).
 * Simples de propósito: contadores, um histograma e gauges calculados na hora da leitura.
 * São por instância; um coletor (Prometheus) soma as instâncias.
 */
type Labels = Record<string, string>;

const key = (name: string, labels: Labels = {}) =>
  `${name}{${Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')}}`;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<
    string,
    { counts: number[]; sum: number; count: number }
  >();
  private gauges = new Map<string, () => Promise<number> | number>();

  inc(name: string, labels?: Labels, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  get(name: string, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  /** Soma todos os contadores com esse nome, qualquer label. */
  total(name: string): number {
    let sum = 0;
    for (const [k, v] of this.counters) if (k.startsWith(`${name}{`)) sum += v;
    return sum;
  }

  observe(name: string, seconds: number, labels?: Labels): void {
    const k = key(name, labels);
    const h = this.histograms.get(k) ?? {
      counts: BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.counts[i] += 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.histograms.set(k, h);
  }

  registerGauge(name: string, read: () => Promise<number> | number): void {
    this.gauges.set(name, read);
  }

  async render(): Promise<string> {
    const lines: string[] = [];
    for (const [k, v] of [...this.counters].sort()) lines.push(`${k} ${v}`);
    for (const [k, h] of [...this.histograms].sort()) {
      const [name, rawLabels] = [
        k.slice(0, k.indexOf('{')),
        k.slice(k.indexOf('{') + 1, -1),
      ];
      const withLe = (le: string) =>
        `${name}_bucket{${rawLabels ? `${rawLabels},` : ''}le="${le}"}`;
      BUCKETS.forEach((b, i) =>
        lines.push(`${withLe(String(b))} ${h.counts[i]}`),
      );
      lines.push(`${withLe('+Inf')} ${h.count}`);
      lines.push(`${name}_sum{${rawLabels}} ${h.sum}`);
      lines.push(`${name}_count{${rawLabels}} ${h.count}`);
    }
    for (const [name, read] of this.gauges) {
      try {
        lines.push(`${name} ${await read()}`);
      } catch {
        // gauge indisponível (ex.: banco fora): simplesmente não aparece
      }
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

export const metrics = new Metrics();

export const M = {
  transactions: 'wager_transactions_total', // {status, kind}
  duplicates: 'wager_duplicates_detected_total', // {channel}
  retries: 'wager_retries_total', // {component}
  dlq: 'wager_dlq_messages_total',
  lockConflicts: 'wager_lock_conflicts_total', // {type}
  lockWait: 'wager_wallet_lock_wait_seconds',
  latency: 'wager_processing_seconds', // {channel}
  outboxPublished: 'outbox_published_total',
  outboxFailures: 'outbox_publish_failures_total',
  outboxLag: 'outbox_lag_seconds',
  reconciliationDivergence: 'wallet_reconciliation_divergence_total',
} as const;

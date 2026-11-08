/**
 * Toda a configuração vem de variáveis de ambiente, com defaults que funcionam
 * com o docker-compose.yml. Lida na hora da chamada (e não ao importar), assim os
 * testes conseguem apontar para outro banco/fila antes de subir a aplicação.
 */
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
}

export function loadConfig() {
  return {
    db: {
      host: process.env.DB_HOST ?? 'localhost',
      port: int('DB_PORT', 5432),
      user: process.env.DB_USER ?? 'wagering',
      password: process.env.DB_PASSWORD ?? 'wagering',
      name: process.env.DB_NAME ?? 'wagering',
    },
    aws: {
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    queues: {
      transactions:
        process.env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
      transactionsDlq:
        process.env.SQS_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
      events: process.env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
    },
    workers: {
      /** Liga/desliga os workers em segundo plano (testes ligam só o que precisam). */
      outboxEnabled: process.env.OUTBOX_WORKER !== 'off',
      consumerEnabled: process.env.SQS_CONSUMER !== 'off',
      pendingEnabled: process.env.PENDING_WORKER !== 'off',
      outboxIntervalMs: int('OUTBOX_INTERVAL_MS', 500),
      outboxBatchSize: int('OUTBOX_BATCH_SIZE', 50),
      pendingIntervalMs: int('PENDING_INTERVAL_MS', 1000),
      pendingBatchSize: int('PENDING_BATCH_SIZE', 50),
    },
    pendingReference: {
      /** Primeira nova tentativa após 2s, depois 4s, 8s... (backoff exponencial) até o teto. */
      baseDelayMs: int('PENDING_BASE_DELAY_MS', 2000),
      maxDelayMs: int('PENDING_MAX_DELAY_MS', 5 * 60 * 1000),
      /** Teto de tentativas e TTL total: o que vier primeiro encerra a espera. */
      maxAttempts: int('PENDING_MAX_ATTEMPTS', 10),
      ttlMs: int('PENDING_TTL_MS', 60 * 60 * 1000),
    },
    outbox: {
      baseDelayMs: int('OUTBOX_BASE_DELAY_MS', 1000),
      maxDelayMs: int('OUTBOX_MAX_DELAY_MS', 60 * 1000),
    },
    consumer: {
      name: process.env.SQS_CONSUMER_NAME ?? 'wager-transactions-consumer',
      waitTimeSeconds: int('SQS_WAIT_SECONDS', 1),
      maxMessages: int('SQS_MAX_MESSAGES', 10),
      visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT', 30),
      /** Espera mínima (s) antes de reentregar uma mensagem que falhou; dobra a cada tentativa. */
      retryBaseSeconds: int('SQS_RETRY_BASE_SECONDS', 1),
      /** Usado no RedrivePolicy: depois disso a mensagem vai para a DLQ. */
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

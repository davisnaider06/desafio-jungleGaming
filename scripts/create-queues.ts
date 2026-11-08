/**
 * Cria as filas no SQS (MiniStack/LocalStack) usando o SDK da AWS:
 *   - wager-transactions-dlq.fifo   (dead-letter queue)
 *   - wager-transactions.fifo       (com RedrivePolicy apontando para a DLQ)
 *   - wager-events.fifo             (saída da outbox)
 *
 * Uso: bun run queues:create      (é idempotente, pode rodar quantas vezes quiser)
 */
import { loadConfig } from '../src/config';
import { createSqsClient, ensureQueues } from '../src/messaging/sqs.service';

async function main() {
  const config = loadConfig();
  const client = createSqsClient(config.aws);
  try {
    const urls = await ensureQueues(
      client,
      config.queues,
      config.consumer.maxReceiveCount,
      config.consumer.visibilityTimeoutSeconds,
    );
    console.log(JSON.stringify({ msg: 'queues ready', ...urls }, null, 2));
  } finally {
    client.destroy();
  }
}

void main();

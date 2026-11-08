/**
 * Cria as filas no SQS (MiniStack/LocalStack) usando o SDK da AWS:
 *   - wager-transactions-dlq.fifo   (dead-letter queue)
 *   - wager-transactions.fifo       (com RedrivePolicy apontando para a DLQ)
 *   - wager-events.fifo             (saída da outbox)
 *
 * Antes de criar, espera o SQS responder (retry com backoff, até ~30 s).
 *
 * Uso: bun run queues:create      (é idempotente, pode rodar quantas vezes quiser)
 */
import { loadConfig } from '../src/config';
import {
  createSqsClient,
  ensureQueues,
  waitForSqs,
} from '../src/messaging/sqs.service';

async function main() {
  const config = loadConfig();
  const client = createSqsClient(config.aws);
  try {
    await waitForSqs(client, {
      timeoutMs: 30_000,
      onRetry: ({ attempt, delayMs }) =>
        console.error(
          `SQS ainda não respondeu em ${config.aws.endpoint} (tentativa ${attempt}); nova tentativa em ${delayMs} ms...`,
        ),
    });
    const urls = await ensureQueues(
      client,
      config.queues,
      config.consumer.maxReceiveCount,
      config.consumer.visibilityTimeoutSeconds,
    );
    console.log(JSON.stringify({ msg: 'queues ready', ...urls }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

void main();

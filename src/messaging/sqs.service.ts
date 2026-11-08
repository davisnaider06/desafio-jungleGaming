import { Inject, Injectable } from '@nestjs/common';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';

export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: {
      accessKeyId: aws.accessKeyId,
      secretAccessKey: aws.secretAccessKey,
    },
  });
}

/**
 * Cria (ou reaproveita) as filas FIFO e a DLQ. Idempotente: pode rodar várias vezes.
 * Usado pelo script `bun run queues:create` e pelos testes de integração.
 *
 * A DLQ é criada primeiro porque o RedrivePolicy da fila principal precisa do ARN dela:
 * depois de `maxReceiveCount` recebimentos sem ack, o SQS move a mensagem sozinho para a DLQ.
 */
export async function ensureQueues(
  client: SQSClient,
  queues: AppConfig['queues'],
  maxReceiveCount: number,
  visibilityTimeoutSeconds = 30,
): Promise<{ transactionsUrl: string; dlqUrl: string; eventsUrl: string }> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: queues.transactionsDlq,
      Attributes: fifo,
    }),
  );
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: queues.transactions,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttrs.Attributes?.QueueArn,
          maxReceiveCount,
        }),
      },
    }),
  );

  // Fila de saída: é para onde o publisher da outbox manda os eventos de integração.
  const events = await client.send(
    new CreateQueueCommand({ QueueName: queues.events, Attributes: fifo }),
  );

  return {
    transactionsUrl: main.QueueUrl!,
    dlqUrl: dlq.QueueUrl!,
    eventsUrl: events.QueueUrl!,
  };
}

@Injectable()
export class SqsService {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = createSqsClient(config.aws);
  }

  /** Resolve a URL da fila pelo nome (e guarda; a URL de uma fila nunca muda). */
  async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );
    this.urls.set(name, QueueUrl!);
    return QueueUrl!;
  }

  /** Readiness: o SQS responde? */
  async ping(): Promise<void> {
    await this.client.send(new ListQueuesCommand({ MaxResults: 1 }));
  }

  destroy(): void {
    this.client.destroy();
  }
}

import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import { createSqsClient, ensureQueues } from '../../src/messaging/sqs.service';

export const config = loadConfig();

export interface TestQueues {
  client: SQSClient;
  transactionsUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

/** Cria as filas reais (MiniStack) com o mesmo código do script `queues:create`. */
export async function setupQueues(): Promise<TestQueues> {
  const client = createSqsClient(config.aws);
  const urls = await ensureQueues(
    client,
    config.queues,
    config.consumer.maxReceiveCount,
    config.consumer.visibilityTimeoutSeconds,
  );
  return { client, ...urls };
}

export async function purgeAll(q: TestQueues): Promise<void> {
  for (const url of [q.transactionsUrl, q.dlqUrl, q.eventsUrl]) {
    await q.client.send(new PurgeQueueCommand({ QueueUrl: url }));
  }
}

/** Mensagem no formato da fila de transações. */
export function wagerMessage(
  body: Record<string, unknown>,
  idempotencyKey: string,
  messageId = randomUUID(),
) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey },
  };
}

export async function sendRaw(
  q: TestQueues,
  body: string,
  groupId: string,
  dedupId = randomUUID(),
) {
  await q.client.send(
    new SendMessageCommand({
      QueueUrl: q.transactionsUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

export async function sendWager(
  q: TestQueues,
  req: { body: unknown; idempotencyKey: string },
  messageId = randomUUID(),
) {
  const body = req.body as { walletId: string };
  await sendRaw(
    q,
    JSON.stringify(
      wagerMessage(
        req.body as Record<string, unknown>,
        req.idempotencyKey,
        messageId,
      ),
    ),
    body.walletId,
  );
  return messageId;
}

/** Lê e apaga tudo o que houver na fila (para checar o que foi publicado). */
export async function drain(
  q: TestQueues,
  url: string,
  maxEmptyPolls = 2,
): Promise<Message[]> {
  const all: Message[] = [];
  let empty = 0;
  while (empty < maxEmptyPolls) {
    const res = await q.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) {
      empty += 1;
      continue;
    }
    empty = 0;
    for (const m of messages) {
      all.push(m);
      await q.client.send(
        new DeleteMessageCommand({
          QueueUrl: url,
          ReceiptHandle: m.ReceiptHandle,
        }),
      );
    }
  }
  return all;
}

export async function depth(
  q: TestQueues,
  url: string,
): Promise<{ visible: number; inFlight: number }> {
  const res = await q.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return {
    visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(
      res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
    ),
  };
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Repete `check` até dar certo ou estourar o tempo. */
export async function eventually<T>(
  check: () => Promise<T>,
  timeoutMs = 15_000,
  everyMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(everyMs);
    }
  }
}

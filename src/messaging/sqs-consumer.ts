import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config';
import { errorFields, logger } from '../observability/logger';
import { M, metrics } from '../observability/metrics';
import {
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidPayloadError,
} from '../shared/errors';
import { APP_CONFIG } from '../tokens';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction.usecase';
import { SqsService } from './sqs.service';

/** Só para testes: simula o processo morrendo (nem ack, nem devolução da mensagem). */
export class SimulatedCrash extends Error {}

/** Formato da mensagem na fila de transações. */
interface WagerTransactionRequested {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: Record<string, unknown> & { idempotencyKey: string };
}

/** A mensagem nunca vai dar certo, não adianta tentar de novo (ex.: JSON inválido). */
class PermanentMessageError extends Error {}

/**
 * Consumidor da fila de transações. Para cada mensagem:
 *
 *  1. valida o envelope (inválido = erro PERMANENTE -> DLQ);
 *  2. chama o MESMO caso de uso do HTTP, com deduplicação persistente por messageId (inbox);
 *  3. só DEPOIS do commit faz DeleteMessage (ack). Se o processo morrer entre o commit e o ack,
 *     a fila reentrega e o inbox descarta, sem duplicar o efeito;
 *  4. classifica falhas:
 *       - NEGÓCIO (ex.: saldo insuficiente): não é erro, vira transação REJECTED e a mensagem é confirmada;
 *       - TRANSITÓRIO (banco fora, deadlock...): não confirma; a mensagem volta com backoff exponencial;
 *         ao atingir o limite de tentativas vai para a DLQ;
 *       - PERMANENTE (payload inválido): vai direto para a DLQ.
 */
@Injectable()
export class SqsConsumer {
  /** Gancho de teste: roda depois do commit e antes do ack. */
  beforeAck?: (message: Message) => Promise<void>;

  private abort = new AbortController();
  private stopping = false;

  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Um ciclo de polling. Devolve quantas mensagens recebeu. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.sqs.queueUrl(this.config.queues.transactions);
    let messages: Message[];
    try {
      const response = await this.sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: this.config.consumer.maxMessages,
          WaitTimeSeconds: this.config.consumer.waitTimeSeconds,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
        }),
        { abortSignal: this.abort.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping) return 0; // long polling interrompido pelo desligamento
      throw error;
    }

    for (const message of messages) {
      if (this.stopping) {
        // Desligando: o que ainda não começamos volta para a fila na hora, sem esperar o timeout.
        await this.release(queueUrl, message);
        continue;
      }
      await this.handle(queueUrl, message);
    }
    return messages.length;
  }

  /** Para de buscar mensagens novas. O que está em andamento termina normalmente. */
  stop(): void {
    this.stopping = true;
    this.abort.abort();
  }

  restart(): void {
    this.stopping = false;
    this.abort = new AbortController();
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );
    let messageId = message.MessageId ?? 'unknown';
    try {
      const envelope = this.parse(message);
      messageId = envelope.messageId;

      const outcome = await this.useCase.executeFromQueue({
        idempotencyKey: envelope.data.idempotencyKey,
        payload: envelope.data,
        correlationId:
          typeof envelope.data.correlationId === 'string'
            ? envelope.data.correlationId
            : envelope.messageId,
        inbox: {
          consumerName: this.config.consumer.name,
          messageId: envelope.messageId,
          payloadHash: createHash('sha256')
            .update(message.Body ?? '')
            .digest('hex'),
        },
      });
      void outcome; // resultado de negócio (inclusive REJECTED) ou duplicata: em todos os casos confirmamos.

      await this.beforeAck?.(message);
      await this.ack(queueUrl, message);
    } catch (error) {
      if (error instanceof SimulatedCrash) return; // "morreu": nada de ack nem de devolver
      await this.handleFailure(
        queueUrl,
        message,
        messageId,
        receiveCount,
        error,
      );
    }
  }

  private async handleFailure(
    queueUrl: string,
    message: Message,
    messageId: string,
    receiveCount: number,
    error: unknown,
  ): Promise<void> {
    const logFields = { messageId, receiveCount, ...errorFields(error) };

    if (error instanceof IdempotencyConflictError) {
      // Conflito de idempotência é determinístico (retry daria o mesmo): confirmamos e deixamos o log/métrica.
      logger.warn('message rejected by idempotency conflict', logFields);
      metrics.inc(M.duplicates, { channel: 'sqs_conflict' });
      await this.ack(queueUrl, message);
      return;
    }

    if (
      error instanceof PermanentMessageError ||
      error instanceof InvalidPayloadError ||
      error instanceof InvalidMoneyError
    ) {
      logger.error('permanent failure, moving message to DLQ', logFields);
      await this.moveToDlq(queueUrl, message, 'permanent');
      return;
    }

    // Transitório (ou bug desconhecido): tentar de novo com backoff, até o limite.
    if (receiveCount >= this.config.consumer.maxReceiveCount) {
      logger.error('retry limit reached, moving message to DLQ', logFields);
      await this.moveToDlq(queueUrl, message, 'retries_exhausted');
      return;
    }
    const delay = Math.min(
      this.config.consumer.retryBaseSeconds * 2 ** (receiveCount - 1),
      900,
    );
    metrics.inc(M.retries, { component: 'sqs_consumer' });
    logger.warn('transient failure, message will be redelivered', {
      ...logFields,
      retryInSeconds: delay,
    });
    await this.sqs.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );
  }

  private parse(message: Message): WagerTransactionRequested {
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      throw new PermanentMessageError('body is not valid JSON');
    }
    const b = body as Partial<WagerTransactionRequested> | null;
    if (
      !b ||
      b.type !== 'WagerTransactionRequested' ||
      typeof b.messageId !== 'string' ||
      b.messageId === '' ||
      !b.data ||
      typeof b.data !== 'object' ||
      typeof b.data.idempotencyKey !== 'string'
    ) {
      throw new PermanentMessageError('unexpected message envelope');
    }
    return b as WagerTransactionRequested;
  }

  private ack(queueUrl: string, message: Message) {
    return this.sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  /** Devolve a mensagem para a fila imediatamente. */
  private release(queueUrl: string, message: Message) {
    return this.sqs.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  /**
   * Manda para a DLQ e só então confirma o original. Fazemos isso nós mesmos (e não só pelo
   * RedrivePolicy da fila) para o limite de tentativas valer em qualquer broker e para erros
   * permanentes irem para a DLQ na primeira vez, sem esperar as tentativas.
   */
  private async moveToDlq(
    queueUrl: string,
    message: Message,
    reason: string,
  ): Promise<void> {
    const dlqUrl = await this.sqs.queueUrl(this.config.queues.transactionsDlq);
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: `${message.MessageId}-dlq`,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
        },
      }),
    );
    metrics.inc(M.dlq);
    await this.ack(queueUrl, message);
  }
}

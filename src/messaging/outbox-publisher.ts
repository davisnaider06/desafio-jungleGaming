import { Inject, Injectable } from '@nestjs/common';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config';
import { Database } from '../persistence/database.service';
import { OutboxRepository } from '../persistence/outbox.repository';
import { errorFields, logger } from '../observability/logger';
import { M, metrics } from '../observability/metrics';
import { APP_CONFIG } from '../tokens';
import { OutboxMessage } from './domain/outbox-message';
import { SqsService } from './sqs.service';

export interface PublishRunResult {
  published: number;
  failed: number;
}

/**
 * Lê eventos da tabela outbox e os publica na fila de eventos.
 *
 * Garantias:
 *  - Nenhum evento é publicado ANTES do commit da transação financeira, porque só existe na
 *    tabela depois que ela confirmou (a linha da outbox nasce na mesma transação).
 *  - Nenhum evento confirmado se perde: fica na tabela até alguém publicar.
 *  - Vários publishers ao mesmo tempo não se atropelam: FOR UPDATE SKIP LOCKED.
 *  - A entrega é AT-LEAST-ONCE: se o publisher morrer depois de enviar e antes de confirmar
 *    no banco, outro reenvia. Quem consome deduplica pelo `eventId` (a fila FIFO também
 *    deduplica por MessageDeduplicationId = eventId dentro da janela de 5 minutos).
 */
@Injectable()
export class OutboxPublisher {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * `beforeCommit` existe para os testes simularem um processo que morre depois de enviar
   * à fila e antes de confirmar no banco.
   */
  async runOnce(
    options: { beforeCommit?: () => Promise<void> } = {},
  ): Promise<PublishRunResult> {
    const result: PublishRunResult = { published: 0, failed: 0 };
    const queueUrl = await this.sqs.queueUrl(this.config.queues.events);

    await this.db.transaction(async (em) => {
      const now = new Date();
      const batch = await this.outbox.lockDue(
        em,
        now,
        this.config.workers.outboxBatchSize,
      );

      for (const message of batch) {
        try {
          await this.send(queueUrl, message);
          message.markPublished(new Date());
          await this.outbox.markPublished(em, message);
          result.published += 1;
        } catch (error) {
          message.scheduleRetry(
            new Date(),
            this.config.outbox.baseDelayMs,
            this.config.outbox.maxDelayMs,
          );
          await this.outbox.saveRetry(em, message);
          result.failed += 1;
          metrics.inc(M.outboxFailures);
          metrics.inc(M.retries, { component: 'outbox' });
          logger.warn('outbox publish failed, will retry', {
            outboxId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            ...errorFields(error),
          });
        }
      }
      await options.beforeCommit?.();
    });

    metrics.inc(M.outboxPublished, undefined, result.published);
    return result;
  }

  private async send(queueUrl: string, message: OutboxMessage): Promise<void> {
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // FIFO: o grupo é a wallet (eventos da mesma wallet saem em ordem);
        // a deduplicação é o eventId (reenvio do mesmo evento não vira duas mensagens).
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}

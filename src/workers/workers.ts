import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { AppConfig } from '../config';
import { OutboxPublisher } from '../messaging/outbox-publisher';
import { SqsConsumer } from '../messaging/sqs-consumer';
import { Database } from '../persistence/database.service';
import { OutboxRepository } from '../persistence/outbox.repository';
import { errorFields, logger } from '../observability/logger';
import { M, metrics } from '../observability/metrics';
import { APP_CONFIG } from '../tokens';
import { PendingReferenceProcessor } from '../wagering/application/pending-reference.processor';
import { BackgroundLoop } from './background-loop';

const logLoopError = (name: string, error: unknown) =>
  logger.error('background loop failed', { loop: name, ...errorFields(error) });

/**
 * Liga os workers em segundo plano quando a aplicação sobe e os desliga com calma no SIGTERM.
 * `beforeApplicationShutdown` roda ANTES de o banco fechar, então o que está em andamento
 * termina e confirma (ou devolve a mensagem à fila) antes de a conexão cair.
 */
@Injectable()
export class WorkersLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private loops: BackgroundLoop[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(SqsConsumer) private readonly consumer: SqsConsumer,
    @Inject(PendingReferenceProcessor)
    private readonly pending: PendingReferenceProcessor,
    @Inject(Database) private readonly db: Database,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
  ) {}

  onApplicationBootstrap(): void {
    const { workers } = this.config;

    // Outbox lag: idade do evento pendente mais antigo, calculada quando o /metrics é lido.
    metrics.registerGauge(M.outboxLag, () =>
      this.db.read((em) => this.outbox.oldestPendingAgeSeconds(em)),
    );

    if (workers.outboxEnabled) {
      this.loops.push(
        new BackgroundLoop(
          'outbox-publisher',
          async () => void (await this.publisher.runOnce()),
          workers.outboxIntervalMs,
          logLoopError,
        ),
      );
    }
    if (workers.consumerEnabled) {
      this.loops.push(
        // O long polling já espera; o intervalo entre ciclos é só um respiro.
        new BackgroundLoop(
          'sqs-consumer',
          async () => void (await this.consumer.pollOnce()),
          50,
          logLoopError,
        ),
      );
    }
    if (workers.pendingEnabled) {
      this.loops.push(
        new BackgroundLoop(
          'pending-reference',
          async () => void (await this.pending.runOnce()),
          workers.pendingIntervalMs,
          logLoopError,
        ),
      );
    }
    for (const loop of this.loops) loop.start();
    logger.info('workers started', { count: this.loops.length });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.consumer.stop(); // interrompe o long polling e devolve o que não foi iniciado
    await Promise.all(this.loops.map((loop) => loop.stop()));
    logger.info('workers stopped');
  }
}

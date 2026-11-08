import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './http/auth.guard';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { loadConfig } from './config';
import { AllExceptionsFilter } from './http/http-exception.filter';
import {
  HealthController,
  MetricsController,
  WageringController,
  WalletsController,
} from './http/controllers';
import { OutboxPublisher } from './messaging/outbox-publisher';
import { SqsConsumer } from './messaging/sqs-consumer';
import { SqsService } from './messaging/sqs.service';
import ormConfig from './mikro-orm.config';
import { Database } from './persistence/database.service';
import { InboxRepository } from './persistence/inbox.repository';
import { LedgerRepository } from './persistence/ledger.repository';
import { OutboxRepository } from './persistence/outbox.repository';
import { WagerTransactionRepository } from './persistence/wager-transaction.repository';
import { WalletRepository } from './persistence/wallet.repository';
import { APP_CONFIG } from './tokens';
import { OutcomeWriter } from './wagering/application/outcome-writer';
import { PendingReferenceProcessor } from './wagering/application/pending-reference.processor';
import { ProcessWagerTransactionUseCase } from './wagering/application/process-wager-transaction.usecase';
import { WagerQueryService } from './wagering/application/wager-query.service';
import { WalletService } from './wallets/application/wallet.service';
import { WorkersLifecycle } from './workers/workers';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [
    HealthController,
    MetricsController,
    WalletsController,
    WageringController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    Database,
    WalletRepository,
    LedgerRepository,
    WagerTransactionRepository,
    InboxRepository,
    OutboxRepository,
    SqsService,
    OutboxPublisher,
    SqsConsumer,
    OutcomeWriter,
    PendingReferenceProcessor,
    WorkersLifecycle,
    WalletService,
    WagerQueryService,
    ProcessWagerTransactionUseCase,
  ],
})
export class AppModule {}

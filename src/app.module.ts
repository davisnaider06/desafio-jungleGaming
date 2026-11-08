import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { loadConfig } from './config';
import { AllExceptionsFilter } from './http/http-exception.filter';
import {
  HealthController,
  WageringController,
  WalletsController,
} from './http/controllers';
import { SqsService } from './messaging/sqs.service';
import ormConfig from './mikro-orm.config';
import { Database } from './persistence/database.service';
import { LedgerRepository } from './persistence/ledger.repository';
import { WagerTransactionRepository } from './persistence/wager-transaction.repository';
import { WalletRepository } from './persistence/wallet.repository';
import { APP_CONFIG } from './tokens';
import { ProcessWagerTransactionUseCase } from './wagering/application/process-wager-transaction.usecase';
import { WagerQueryService } from './wagering/application/wager-query.service';
import { WalletService } from './wallets/application/wallet.service';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    Database,
    WalletRepository,
    LedgerRepository,
    WagerTransactionRepository,
    SqsService,
    WalletService,
    WagerQueryService,
    ProcessWagerTransactionUseCase,
  ],
})
export class AppModule {}

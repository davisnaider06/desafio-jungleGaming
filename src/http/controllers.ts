import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { InvalidPayloadError } from '../shared/errors';
import { WagerTransactionStatus } from '../wagering/domain/wager-transaction';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction.usecase';
import { WagerQueryService } from '../wagering/application/wager-query.service';
import { WalletService } from '../wallets/application/wallet.service';
import { Database } from '../persistence/database.service';
import { SqsService } from '../messaging/sqs.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string, name: string): string {
  if (!UUID.test(value))
    throw new InvalidPayloadError(`${name} must be a UUID`);
  return value.toLowerCase();
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.wallets.create(body); // 201 (padrão do POST)
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.wallets.get(uuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    let size = 50;
    if (limit !== undefined) {
      size = Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > 200) {
        throw new InvalidPayloadError(
          'limit must be an integer between 1 and 200',
        );
      }
    }
    return this.wallets.listLedger(uuid(walletId, 'walletId'), cursor, size);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.wallets.reconcile(uuid(walletId, 'walletId'));
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly process: ProcessWagerTransactionUseCase,
    @Inject(WagerQueryService) private readonly queries: WagerQueryService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    const result = await this.process.execute({
      idempotencyKey,
      payload: body,
      correlationId: correlationId ?? randomUUID(),
    });
    // Mapeamento de status (ver tabela no filtro de exceções):
    //   REJECTED -> 422 | PENDING_REFERENCE -> 202 | PROCESSED -> 201 na 1ª vez, 200 no replay
    if (result.status === WagerTransactionStatus.Rejected) res.status(422);
    else if (result.status === WagerTransactionStatus.PendingReference)
      res.status(202);
    else res.status(result.idempotentReplay ? 200 : 201);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') id: string) {
    return this.queries.getById(uuid(id, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getByProviderExternal(
      providerId,
      externalTransactionId,
    );
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SqsService) private readonly sqs: SqsService,
  ) {}

  /** Liveness: o processo está de pé. Não toca em dependências externas. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: só fica "ready" se o Postgres E o SQS respondem. */
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    const check = async (fn: () => Promise<void>) => {
      try {
        await fn();
        return 'up';
      } catch {
        return 'down';
      }
    };
    const [postgres, sqs] = await Promise.all([
      check(() => this.db.ping()),
      check(() => this.sqs.ping()),
    ]);
    const ready = postgres === 'up' && sqs === 'up';
    if (!ready) res.status(503);
    return { status: ready ? 'ready' : 'not_ready', checks: { postgres, sqs } };
  }
}

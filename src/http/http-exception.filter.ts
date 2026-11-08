import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidPayloadError,
  NotFoundError,
  WalletAlreadyExistsError,
} from '../shared/errors';
import { isTransientInfrastructureError } from '../shared/transient-errors';

/**
 * Tabela ÚNICA de erro -> status HTTP (a mesma para todos os endpoints):
 *
 *   400  payload inválido / header ausente     INVALID_PAYLOAD
 *   404  recurso inexistente                   NOT_FOUND
 *   409  conflito de idempotência / wallet já existe
 *   422  (não passa por aqui) rejeição de regra de negócio: o controller devolve 422 com status REJECTED
 *   503  falha transitória de infraestrutura (Postgres/SQS)   TRANSIENT_FAILURE
 *   500  qualquer outra coisa (bug)            INTERNAL_ERROR
 *
 * Sucesso: 200 (replay/consultas), 201 (criado), 202 (aceito, aguardando referência).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrors');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const send = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } });

    if (
      error instanceof InvalidPayloadError ||
      error instanceof InvalidMoneyError
    ) {
      return send(400, 'INVALID_PAYLOAD', error.message);
    }
    if (error instanceof NotFoundError)
      return send(404, 'NOT_FOUND', error.message);
    if (error instanceof IdempotencyConflictError) {
      return send(409, 'IDEMPOTENCY_CONFLICT', error.message);
    }
    if (error instanceof WalletAlreadyExistsError) {
      return send(409, 'WALLET_ALREADY_EXISTS', error.message);
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return send(
        status,
        status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
        error.message,
      );
    }
    if (isTransientInfrastructureError(error)) {
      this.logger.warn(
        JSON.stringify({ msg: 'transient failure', error: String(error) }),
      );
      res.setHeader('Retry-After', '1');
      return send(
        503,
        'TRANSIENT_FAILURE',
        'temporary infrastructure failure, retry later',
      );
    }
    this.logger.error(
      JSON.stringify({ msg: 'unhandled error', error: String(error) }),
    );
    return send(500, 'INTERNAL_ERROR', 'internal error');
  }
}

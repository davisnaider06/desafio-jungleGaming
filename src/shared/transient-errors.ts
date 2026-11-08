import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  TransactionStateError,
} from '@mikro-orm/core';
import { WalletVersionConflictError } from './errors';

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/**
 * Mensagens de erro de CONEXÃO do driver `pg` (node-postgres) que chegam SEM `code`.
 *
 * Achado na prova de fogo manual: com o Postgres parado, o encaminhador de portas do Docker
 * aceita a conexão e a fecha; o `pg` então lança um `Error` comum (às vezes embrulhado em
 * `DriverException`) com a mensagem "Connection terminated unexpectedly", sem `code` nenhum.
 * Sem `code`, a única pista é a mensagem, por isso a comparação é EXATA e ancorada: só estas
 * frases do `pg`. Nada de `includes('connection')`, que pegaria bug de programação.
 */
const PG_CONNECTION_MESSAGES = new Set([
  'connection terminated unexpectedly',
  'connection terminated',
  'connection terminated due to connection timeout',
  'connection ended unexpectedly',
  'timeout exceeded when trying to connect',
  'client has encountered a connection error and is not queryable',
  'client was closed and is not queryable',
]);

/**
 * Falha TRANSITÓRIA de infraestrutura (Postgres ou SQS fora do ar, deadlock, timeout de lock).
 * Tentar de novo mais tarde pode funcionar. HTTP responde 503; a fila deixa a mensagem voltar.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  // Várias tentativas de conexão falharam juntas (ex.: IPv4 e IPv6 recusados).
  const aggregated = (error as { errors?: unknown }).errors;
  if (
    error instanceof AggregateError &&
    Array.isArray(aggregated) &&
    aggregated.length > 0 &&
    aggregated.every(isTransientInfrastructureError)
  ) {
    return true;
  }
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException ||
    error instanceof TransactionStateError ||
    error instanceof WalletVersionConflictError
  ) {
    return true;
  }
  const e = error as {
    code?: unknown;
    name?: string;
    message?: unknown;
    $metadata?: { httpStatusCode?: number };
    cause?: unknown;
  };
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  if (
    error instanceof Error &&
    typeof e.message === 'string' &&
    PG_CONNECTION_MESSAGES.has(e.message.trim().toLowerCase())
  ) {
    return true;
  }
  // AWS SDK: timeouts, throttling e 5xx
  if (e.name === 'TimeoutError' || e.name === 'ThrottlingException')
    return true;
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && status >= 500) return true;
  if (e.cause) return isTransientInfrastructureError(e.cause);
  return false;
}

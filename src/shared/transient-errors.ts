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
 * Falha TRANSITÓRIA de infraestrutura (Postgres ou SQS fora do ar, deadlock, timeout de lock).
 * Tentar de novo mais tarde pode funcionar. HTTP responde 503; a fila deixa a mensagem voltar.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
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
    $metadata?: { httpStatusCode?: number };
    cause?: unknown;
  };
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  // AWS SDK: timeouts, throttling e 5xx
  if (e.name === 'TimeoutError' || e.name === 'ThrottlingException')
    return true;
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && status >= 500) return true;
  if (e.cause) return isTransientInfrastructureError(e.cause);
  return false;
}

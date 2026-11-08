import type { AppConfig } from '../../config';

/**
 * Espera por uma referência que ainda não chegou (PENDING_REFERENCE).
 *
 * Backoff exponencial: base, 2x base, 4x base... limitado por maxDelay.
 * Desiste quando bater o limite de tentativas OU o TTL total, o que vier primeiro.
 * Com os defaults (base 2s, teto 5min, 10 tentativas) a espera soma ~20 minutos, e o
 * TTL de 1h cobre o caso de o worker ficar parado por um tempo.
 */
export function nextPendingDelayMs(
  attempts: number,
  cfg: AppConfig['pendingReference'],
): number {
  return Math.min(cfg.baseDelayMs * 2 ** attempts, cfg.maxDelayMs);
}

export function shouldGiveUp(
  attemptsSoFar: number,
  createdAt: Date,
  now: Date,
  cfg: AppConfig['pendingReference'],
): boolean {
  return (
    attemptsSoFar + 1 >= cfg.maxAttempts ||
    now.getTime() - createdAt.getTime() >= cfg.ttlMs
  );
}

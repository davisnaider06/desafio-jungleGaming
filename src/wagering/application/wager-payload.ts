import { InvalidMoneyError, InvalidPayloadError } from '../../shared/errors';
import { canonicalHash } from '../../shared/canonical-hash';
import { Money } from '../../shared/money';
import {
  WagerTransactionInput,
  WagerTransactionKind,
} from '../domain/wager-transaction';

const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > maxLength
  ) {
    throw new InvalidPayloadError(
      `${field} must be a non-empty string up to ${maxLength} chars`,
    );
  }
  return value;
}

/**
 * Valida o corpo recebido (HTTP ou fila) e devolve o contrato tipado.
 * O mesmo código vale para os dois canais: o providerId que vem da fila também é validado.
 */
export function parseWagerPayload(body: unknown): WagerTransactionInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidPayloadError('body must be a JSON object');
  }
  const obj = body as Record<string, unknown>;

  const kind = requiredString(obj, 'kind', 16);
  if (!SUBMITTABLE_KINDS.has(kind)) {
    throw new InvalidPayloadError(
      `kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK`,
    );
  }

  let money: Money;
  try {
    money = Money.from(obj.money as never);
  } catch (error) {
    if (error instanceof InvalidMoneyError)
      throw new InvalidPayloadError(error.message);
    throw error;
  }

  const ref = obj.referenceExternalTransactionId;
  if (
    ref !== undefined &&
    ref !== null &&
    (typeof ref !== 'string' || ref === '' || ref.length > 128)
  ) {
    throw new InvalidPayloadError(
      'referenceExternalTransactionId must be a non-empty string',
    );
  }

  const walletId = requiredString(obj, 'walletId', 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      walletId,
    )
  ) {
    throw new InvalidPayloadError('walletId must be a UUID');
  }

  return {
    providerId: requiredString(obj, 'providerId', 64),
    externalTransactionId: requiredString(obj, 'externalTransactionId', 128),
    playerId: requiredString(obj, 'playerId', 64),
    walletId: walletId.toLowerCase(),
    roundId: requiredString(obj, 'roundId', 128),
    gameId: requiredString(obj, 'gameId', 128),
    kind: kind as WagerTransactionKind,
    money,
    referenceExternalTransactionId: typeof ref === 'string' ? ref : undefined,
  };
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '' || key.length > 256) {
    throw new InvalidPayloadError(
      'Idempotency-Key header is required (max 256 chars)',
    );
  }
  return key;
}

/**
 * payloadHash = SHA-256 do JSON CANÔNICO (chaves ordenadas) dos campos de negócio.
 * Fora do hash: o header Idempotency-Key e qualquer metadado de transporte
 * (correlationId, messageId...). O dinheiro entra já normalizado ("10" e "10.00" dão o mesmo hash).
 */
export function hashPayload(input: WagerTransactionInput): string {
  return canonicalHash({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money.toJSON(),
    referenceExternalTransactionId:
      input.referenceExternalTransactionId ?? null,
  });
}

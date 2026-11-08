/**
 * Erros de domínio: violações de regra que o código de negócio detecta.
 * Cada um tem um `code` estável para o chamador decidir o que fazer.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/** Erro de programação: tentaram mudar o estado de uma transação já terminal. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvalidPayloadError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

/** Alguém mudou a wallet sem passar pelo lock: o UPDATE com a `version` esperada não achou a linha. Tentar de novo resolve. */
export class WalletVersionConflictError extends Error {}

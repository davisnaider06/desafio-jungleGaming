import {
  InvalidPayloadError,
  InvalidTransactionStateError,
} from '../../shared/errors';
import { Money } from '../../shared/money';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';
import { FailureCode } from './failure-codes';

export enum WagerTransactionKind {
  /** Interno: abertura da wallet com saldo inicial. Nunca vem da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Transições válidas (documentadas também no ARCHITECTURE.md):
 *
 *   PENDING            -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED, REJECTED, FAILED -> (terminais, nada sai deles)
 */
const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Dados de negócio que formam o payloadHash e o contrato de entrada. */
export interface WagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionCreateProps extends WagerTransactionInput {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState extends WagerTransactionCreateProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo da wallet no momento em que a transação foi decidida. Devolvido nos replays. */
  balanceSnapshot?: Money;
  pendingAttempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _balanceSnapshot?: Money;
  private _pendingAttempts: number;
  private _nextAttemptAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._balanceSnapshot = state.balanceSnapshot;
    this._pendingAttempts = state.pendingAttempts;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  /** Transação vinda de fora (API/fila). Nasce PENDING. OPENING é proibido aqui. */
  static create(props: WagerTransactionCreateProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidPayloadError('OPENING cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidPayloadError(`unknown kind: ${String(props.kind)}`);
    }
    if (!props.money.isPositive()) {
      throw new InvalidPayloadError('amount must be greater than zero');
    }
    const needsReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (needsReference && !props.referenceExternalTransactionId) {
      throw new InvalidPayloadError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      pendingAttempts: 0,
    });
  }

  /** Transação interna de abertura de wallet: já nasce PROCESSED. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    return new WagerTransaction({
      id: props.id,
      providerId: 'INTERNAL',
      externalTransactionId: props.walletId,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'OPENING',
      gameId: 'OPENING',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
      balanceSnapshot: props.money,
      pendingAttempts: 0,
    });
  }

  /** Reconstrói do banco sem revalidar transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceSnapshot(): Money | undefined {
    return this._balanceSnapshot;
  }
  get pendingAttempts(): number {
    return this._pendingAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições ----

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    balance: Money,
  ): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceSnapshot = balance;
    this._nextAttemptAt = undefined;
  }

  /** Referência ainda não chegou. Pode ser chamado de novo a cada tentativa do worker. */
  markPendingReference(
    nextAttemptAt: Date,
    balance: Money | undefined,
    countAttempt = false,
  ): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
    this._balanceSnapshot = balance;
    if (countAttempt) this._pendingAttempts += 1;
  }

  /** Recusa por regra de negócio. Não mexe em saldo nem em ledger. */
  reject(code: FailureCode, at: Date, balance: Money | undefined): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._balanceSnapshot = balance;
    this._nextAttemptAt = undefined;
  }

  /** Falha técnica permanente (não é regra de negócio). */
  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas ----

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** LOSS só registra o resultado, sem mexer no saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  /** REFUND e ROLLBACK desfazem outra transação. */
  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  /**
   * Direção do lançamento no ledger. ROLLBACK é o inverso da referência:
   * reverter BET devolve (CREDIT), reverter WIN/REFUND retira (DEBIT).
   */
  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidPayloadError(
            'ROLLBACK needs the reference to know the direction',
          );
        }
        const original = reference.ledgerDirectionFor();
        if (original === undefined) {
          throw new InvalidPayloadError(
            'referenced transaction has no ledger entry',
          );
        }
        return original === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${operation} transaction ${this.id}: already ${this._status}`,
      );
    }
  }
}

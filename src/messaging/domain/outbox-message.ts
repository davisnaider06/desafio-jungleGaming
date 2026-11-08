import type { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

/**
 * Evento que ainda precisa ser publicado. Nasce na MESMA transação SQL da mudança financeira
 * (transactional outbox): se a transação desfaz, o evento some junto; se confirma, o evento
 * está garantido no banco mesmo que o processo morra antes de publicar.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage(
      event.eventId, // o id da mensagem é o eventId: dá para deduplicar quem consome
      event.aggregateId,
      event.eventType,
      Object.freeze(event.toJSON() as unknown as Record<string, unknown>),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Publicação falhou: conta a tentativa e agenda a próxima com backoff exponencial. */
  scheduleRetry(now: Date, baseDelayMs = 1000, maxDelayMs = 60_000): void {
    this._attempts += 1;
    const delay = Math.min(baseDelayMs * 2 ** (this._attempts - 1), maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}

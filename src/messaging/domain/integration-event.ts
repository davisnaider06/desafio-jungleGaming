import { randomUUID } from 'node:crypto';

export interface EventContext {
  /** Liga todos os efeitos de uma mesma requisição/mensagem (logs, eventos). */
  correlationId: string;
  /** O que causou este evento (ex.: o messageId da fila). */
  causationId?: string;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
  eventId?: string;
  occurredAt?: Date;
}

/**
 * Envelope comum dos eventos publicados para outros sistemas.
 *
 * Cada evento concreto é uma subclasse com `eventType` e `version` fixos NO TIPO
 * (literais), então não dá para publicar um evento com nome errado por engano.
 * O construtor é protected: só as subclasses criam eventos (via `from`).
 *
 * `data` carrega só tipos simples (MoneyProps com strings), nunca a instância de Money.
 */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze({ ...props.data });
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

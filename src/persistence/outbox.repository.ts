import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import { OutboxMessageRecord } from './records';

@Injectable()
export class OutboxRepository {
  /** Chamado dentro da MESMA transação da mudança financeira. */
  async insertAll(em: EntityManager, messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) {
      await em.insert(OutboxMessageRecord, {
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: m.payload as Record<string, unknown>,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt,
        publishedAt: null,
      });
    }
  }

  /**
   * Pega um lote de eventos vencidos e TRAVA as linhas com FOR UPDATE SKIP LOCKED.
   * Dois publishers rodando ao mesmo tempo nunca pegam a mesma linha: quem chega depois
   * "pula" as linhas travadas e pega outras. Se o publisher morrer, o lock some com a
   * conexão e outro assume o lote.
   */
  async lockDue(
    em: EntityManager,
    now: Date,
    limit: number,
  ): Promise<OutboxMessage[]> {
    const rows = await em.execute<OutboxMessageRecord[]>(
      `select id, aggregate_id as "aggregateId", event_type as "eventType", payload,
              occurred_at as "occurredAt", attempts, next_attempt_at as "nextAttemptAt"
         from outbox_messages
        where published_at is null and next_attempt_at <= ?
        order by occurred_at, id
        limit ?
        for update skip locked`,
      [now, limit],
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregateId,
        eventType: r.eventType,
        payload: r.payload,
        occurredAt: new Date(r.occurredAt),
        attempts: r.attempts,
        nextAttemptAt: new Date(r.nextAttemptAt),
      }),
    );
  }

  async markPublished(
    em: EntityManager,
    message: OutboxMessage,
  ): Promise<void> {
    await em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      { publishedAt: message.publishedAt, attempts: message.attempts },
    );
  }

  async saveRetry(em: EntityManager, message: OutboxMessage): Promise<void> {
    await em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt },
    );
  }

  /** Idade (em segundos) do evento pendente mais antigo. É o "outbox lag". */
  async oldestPendingAgeSeconds(em: EntityManager): Promise<number> {
    const [row] = await em.execute<{ age: string | null }[]>(
      `select extract(epoch from (now() - min(occurred_at)))::text as age
         from outbox_messages where published_at is null`,
    );
    return row?.age ? Math.max(0, Number.parseFloat(row.age)) : 0;
  }
}

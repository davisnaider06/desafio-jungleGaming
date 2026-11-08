import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../messaging/domain/inbox-message';

@Injectable()
// ATENÇÃO (bug real que já aconteceu aqui): dentro de uma transação use `em.execute(...)`.
// `em.getConnection().execute(...)` roda em OUTRA conexão do pool, fora da transação: o INSERT do
// inbox seria confirmado sozinho e, se o processo morresse antes do commit financeiro, a mensagem
// reentregue seria descartada como "já processada" e a aposta se perderia.
export class InboxRepository {
  /**
   * Registra a mensagem. Devolve false se (consumerName, messageId) já existia = duplicata.
   * `ON CONFLICT DO NOTHING` é atômico: se duas entregas da mesma mensagem chegam juntas,
   * a segunda espera a primeira e só uma devolve true.
   */
  async receive(em: EntityManager, message: InboxMessage): Promise<boolean> {
    const rows = await em.execute<unknown[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
      ],
    );
    return rows.length === 1;
  }

  async markProcessed(em: EntityManager, message: InboxMessage): Promise<void> {
    await em.execute(
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [message.processedAt, message.consumerName, message.messageId],
    );
  }
}

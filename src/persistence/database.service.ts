import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Porta de entrada para falar com o banco. Cada chamada usa um EntityManager NOVO (fork),
 * então requisições simultâneas nunca compartilham Identity Map nem transação.
 */
@Injectable()
export class Database {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /**
   * Roda `fn` numa transação SQL. Se `fn` lançar erro, tudo é desfeito (rollback).
   * É aqui que ficam atômicos: transação + saldo + ledger + inbox + outbox.
   */
  transaction<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork() as unknown as EntityManager;
    return em.transactional(fn);
  }

  /** Leitura simples, fora de transação. */
  read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return fn(this.orm.em.fork() as unknown as EntityManager);
  }

  /** Para o health check: o Postgres responde? */
  async ping(): Promise<void> {
    await this.orm.em.getConnection().execute('select 1');
  }
}

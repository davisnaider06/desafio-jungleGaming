import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { Database } from '../../persistence/database.service';
import { WagerTransactionRepository } from '../../persistence/wager-transaction.repository';
import { WalletRepository } from '../../persistence/wallet.repository';
import { logger } from '../../observability/logger';
import { M, metrics } from '../../observability/metrics';
import { APP_CONFIG } from '../../tokens';
import { processWager } from '../domain/wager-processor';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { OutcomeWriter } from './outcome-writer';
import { nextPendingDelayMs, shouldGiveUp } from './pending-policy';
import { randomUUID } from 'node:crypto';

/**
 * Reprocessa transações PENDING_REFERENCE (REFUND/ROLLBACK que chegaram ANTES da transação que
 * elas desfazem). Rodado periodicamente por todas as instâncias; o `FOR UPDATE SKIP LOCKED` faz
 * cada linha ser tratada por UMA instância por vez.
 *
 * A cada tentativa que ainda não acha a referência: tentativas + 1 e próxima tentativa com
 * backoff exponencial. Ao estourar o limite de tentativas ou o TTL, a transação vira
 * REJECTED / REFERENCE_NOT_FOUND e o evento WagerTransactionRejected é publicado.
 */
@Injectable()
export class PendingReferenceProcessor {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository)
    private readonly txs: WagerTransactionRepository,
    @Inject(OutcomeWriter) private readonly writer: OutcomeWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Devolve quantas transações foram avaliadas. */
  async runOnce(): Promise<number> {
    const cfg = this.config.pendingReference;
    const finished: { kind: string; status: string }[] = [];

    const evaluated = await this.db.transaction(async (em) => {
      const now = new Date();
      const due = await this.txs.lockDuePendingReference(
        em,
        now,
        this.config.workers.pendingBatchSize,
      );

      for (const tx of due) {
        // Mesma regra de ouro do fluxo normal: trava a wallet antes de decidir qualquer coisa.
        const wallet = await this.wallets.findByIdForUpdate(em, tx.walletId);
        const reference = tx.referenceExternalTransactionId
          ? await this.txs.findByProviderExternal(
              em,
              tx.providerId,
              tx.referenceExternalTransactionId,
            )
          : null;
        const referenceAlreadyReversed =
          reference && tx.isReversal()
            ? await this.txs.isReversed(em, reference.id)
            : false;

        const previousStatus = tx.status;
        const walletVersionBefore = wallet?.version ?? 0;
        const entry = processWager({
          tx,
          wallet,
          reference,
          referenceAlreadyReversed,
          now,
          newEntryId: randomUUID,
          nextAttemptAt: new Date(
            now.getTime() + nextPendingDelayMs(tx.pendingAttempts + 1, cfg),
          ),
          giveUpWaitingReference: shouldGiveUp(
            tx.pendingAttempts,
            tx.createdAt,
            now,
            cfg,
          ),
        });

        await this.writer.write(em, {
          tx,
          isNew: false,
          previousStatus,
          wallet,
          walletVersionBefore,
          entry,
          ctx: { correlationId: tx.id, causationId: tx.id },
        });

        if (tx.status !== WagerTransactionStatus.PendingReference) {
          finished.push({ kind: tx.kind, status: tx.status });
          logger.info('pending reference resolved', {
            transactionId: tx.id,
            walletId: tx.walletId,
            providerId: tx.providerId,
            status: tx.status,
            failureCode: tx.failureCode,
          });
        } else {
          metrics.inc(M.retries, { component: 'pending_reference' });
        }
      }
      return due.length;
    });

    for (const f of finished) metrics.inc(M.transactions, f);
    return evaluated;
  }
}

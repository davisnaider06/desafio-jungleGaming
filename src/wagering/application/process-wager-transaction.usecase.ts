import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { AppConfig } from '../../config';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { Database } from '../../persistence/database.service';
import { InboxRepository } from '../../persistence/inbox.repository';
import { WagerTransactionRepository } from '../../persistence/wager-transaction.repository';
import { WalletRepository } from '../../persistence/wallet.repository';
import { logger } from '../../observability/logger';
import { M, metrics } from '../../observability/metrics';
import {
  IdempotencyConflictError,
  WalletVersionConflictError,
} from '../../shared/errors';
import type { MoneyProps } from '../../shared/money';
import { APP_CONFIG } from '../../tokens';
import { FailureCode } from '../domain/failure-codes';
import { processWager } from '../domain/wager-processor';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { OutcomeWriter } from './outcome-writer';
import { nextPendingDelayMs } from './pending-policy';
import {
  hashPayload,
  parseWagerPayload,
  validateIdempotencyKey,
} from './wager-payload';

export interface WagerSubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo da wallet no momento da decisão (igual em todos os replays). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface InboxInput {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerInput {
  idempotencyKey: unknown;
  payload: unknown;
  correlationId?: string;
  /** Só quando a origem é a fila: ativa a deduplicação persistente por messageId. */
  inbox?: InboxInput;
}

/** `inboxDuplicate`: a MENSAGEM já tinha sido processada; nada foi feito e o chamador só confirma (ack). */
export type SubmitOutcome = WagerSubmitResult | { inboxDuplicate: true };

export function toResult(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): WagerSubmitResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.balanceSnapshot?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

/**
 * Caso de uso ÚNICO para processar uma transação, usado tanto pelo HTTP quanto pelo
 * consumidor SQS. Não existe segundo caminho com regras diferentes.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository)
    private readonly txs: WagerTransactionRepository,
    @Inject(InboxRepository) private readonly inbox: InboxRepository,
    @Inject(OutcomeWriter) private readonly writer: OutcomeWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Entrada HTTP. */
  async execute(
    input: Omit<SubmitWagerInput, 'inbox'>,
  ): Promise<WagerSubmitResult> {
    return (await this.run(input)) as WagerSubmitResult;
  }

  /** Entrada da fila SQS: mesma regra de negócio, mais deduplicação por messageId (inbox). */
  executeFromQueue(
    input: SubmitWagerInput & { inbox: InboxInput },
  ): Promise<SubmitOutcome> {
    return this.run(input);
  }

  private async run(input: SubmitWagerInput): Promise<SubmitOutcome> {
    const started = performance.now();
    const channel = input.inbox ? 'sqs' : 'http';
    const key = validateIdempotencyKey(input.idempotencyKey);
    const parsed = parseWagerPayload(input.payload);
    const hash = hashPayload(parsed);
    const correlationId = input.correlationId ?? randomUUID();

    // Se duas requisições com a mesma chave disputarem um INSERT, o banco recusa uma delas
    // (unique em idempotency_key / ledger). Basta tentar de novo: agora a transação já existe e vira replay.
    let outcome: SubmitOutcome;
    for (let attempt = 1; ; attempt++) {
      try {
        outcome = await this.attempt(
          key,
          parsed,
          hash,
          correlationId,
          input.inbox,
        );
        break;
      } catch (error) {
        const conflict =
          error instanceof UniqueConstraintViolationException ||
          error instanceof WalletVersionConflictError;
        if (conflict && attempt < 3) {
          metrics.inc(M.lockConflicts, { type: 'retry_after_conflict' });
          metrics.inc(M.retries, { component: 'process_wager' });
          continue;
        }
        throw error;
      }
    }

    // Métricas e log só DEPOIS do commit (o que foi desfeito não conta).
    metrics.observe(M.latency, (performance.now() - started) / 1000, {
      channel,
    });
    if ('inboxDuplicate' in outcome) {
      metrics.inc(M.duplicates, { channel: 'sqs_inbox' });
      logger.info('duplicate message ignored', {
        correlationId,
        messageId: input.inbox?.messageId,
        providerId: parsed.providerId,
      });
    } else {
      if (outcome.idempotentReplay)
        metrics.inc(M.duplicates, { channel: 'idempotency_key' });
      else
        metrics.inc(M.transactions, {
          status: outcome.status,
          kind: parsed.kind,
        });
      logger.info('wager transaction handled', {
        correlationId,
        messageId: input.inbox?.messageId,
        transactionId: outcome.transactionId,
        walletId: parsed.walletId,
        providerId: parsed.providerId,
        status: outcome.status,
        failureCode: outcome.failureCode,
        replay: outcome.idempotentReplay,
      });
    }
    return outcome;
  }

  private async attempt(
    key: string,
    parsed: ReturnType<typeof parseWagerPayload>,
    hash: string,
    correlationId: string,
    inboxInput?: InboxInput,
  ): Promise<SubmitOutcome> {
    // Caminho rápido: repetição de algo já decidido não precisa de lock nenhum.
    // (Mensagens da fila sempre passam pela transação, para registrar o inbox.)
    if (!inboxInput) {
      const known = await this.db.read((em) =>
        this.txs.findByIdempotencyKey(em, key),
      );
      if (known) return this.replay(known, hash);
    }

    return this.db.transaction(async (em) => {
      // INBOX: "já vi esta mensagem?". Gravado na MESMA transação do efeito financeiro:
      // se o processo morrer antes do commit, o inbox some junto e a mensagem pode ser reprocessada;
      // se morrer depois do commit (antes do ack), a reentrega cai aqui e é descartada.
      const inboxMessage = inboxInput
        ? InboxMessage.receive(inboxInput)
        : undefined;
      if (inboxMessage && !(await this.inbox.receive(em, inboxMessage))) {
        return { inboxDuplicate: true } as const;
      }
      const finishInbox = async () => {
        if (!inboxMessage) return;
        inboxMessage.markProcessed(new Date());
        await this.inbox.markProcessed(em, inboxMessage);
      };

      // LOCK por wallet. Todas as operações da mesma wallet passam por esta linha, uma de cada vez;
      // o resto das wallets segue em paralelo. Sem isso, "ler saldo -> calcular -> gravar" perderia atualizações.
      const lockStarted = performance.now();
      const wallet = await this.wallets.findByIdForUpdate(em, parsed.walletId);
      metrics.observe(M.lockWait, (performance.now() - lockStarted) / 1000);

      // IDEMPOTÊNCIA: checa de novo DEPOIS do lock. Quem esperou o lock enxerga o commit de quem passou antes,
      // então 50 requisições iguais em paralelo geram 1 débito e 49 replays.
      const existing = await this.txs.findByIdempotencyKey(em, key);
      if (existing) {
        const replayed = this.replay(existing, hash);
        await finishInbox();
        return replayed;
      }

      const sameExternal = await this.txs.findByProviderExternal(
        em,
        parsed.providerId,
        parsed.externalTransactionId,
      );
      if (sameExternal) {
        throw new IdempotencyConflictError(
          `transaction ${parsed.providerId}/${parsed.externalTransactionId} already exists under another Idempotency-Key`,
        );
      }

      const now = new Date();
      const tx = WagerTransaction.create({
        ...parsed,
        id: randomUUID(),
        idempotencyKey: key,
        payloadHash: hash,
        createdAt: now,
      });

      const reference = parsed.referenceExternalTransactionId
        ? await this.txs.findByProviderExternal(
            em,
            parsed.providerId,
            parsed.referenceExternalTransactionId,
          )
        : null;
      const referenceAlreadyReversed =
        reference && tx.isReversal()
          ? await this.txs.isReversed(em, reference.id)
          : false;

      const walletVersionBefore = wallet?.version ?? 0;
      const previousStatus = tx.status;
      const entry = processWager({
        tx,
        wallet,
        reference,
        referenceAlreadyReversed,
        now,
        newEntryId: randomUUID,
        nextAttemptAt: new Date(
          now.getTime() + nextPendingDelayMs(0, this.config.pendingReference),
        ),
        giveUpWaitingReference: false,
      });

      await this.writer.write(em, {
        tx,
        isNew: true,
        previousStatus,
        wallet,
        walletVersionBefore,
        entry,
        ctx: { correlationId, causationId: inboxInput?.messageId },
      });
      await finishInbox();
      return toResult(tx, false);
    });
  }

  private replay(existing: WagerTransaction, hash: string): WagerSubmitResult {
    if (!existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError(
        'Idempotency-Key was already used with a different payload',
      );
    }
    return toResult(existing, true);
  }
}

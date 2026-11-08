import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { EventContext } from '../../messaging/domain/integration-event';
import { LedgerRepository } from '../../persistence/ledger.repository';
import { OutboxRepository } from '../../persistence/outbox.repository';
import { WagerTransactionRepository } from '../../persistence/wager-transaction.repository';
import { WalletRepository } from '../../persistence/wallet.repository';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { eventsForOutcome } from './events-for-outcome';

/**
 * Grava o resultado de uma decisão. TUDO na transação SQL que o chamador já abriu:
 *   transação + lançamento do ledger + novo saldo + eventos da outbox.
 * Se qualquer passo falhar, a transação inteira desfaz. Nunca existe saldo sem ledger,
 * nem evento sem a mudança que ele descreve.
 */
@Injectable()
export class OutcomeWriter {
  constructor(
    @Inject(WagerTransactionRepository)
    private readonly txs: WagerTransactionRepository,
    @Inject(LedgerRepository) private readonly ledger: LedgerRepository,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
  ) {}

  async write(
    em: EntityManager,
    args: {
      tx: WagerTransaction;
      /** true: transação nova (INSERT). false: já existia como PENDING_REFERENCE (UPDATE). */
      isNew: boolean;
      previousStatus: WagerTransactionStatus;
      wallet: Wallet | null;
      walletVersionBefore: number;
      entry?: WalletLedgerEntry;
      ctx: EventContext;
    },
  ): Promise<void> {
    const { tx, wallet, entry } = args;

    if (args.isNew) await this.txs.insert(em, tx);
    else await this.txs.update(em, tx);

    if (entry && wallet) {
      // A transação precisa existir antes do lançamento (FK). O saldo só muda aqui,
      // com a versão esperada no WHERE (rede de segurança contra lost update).
      await this.ledger.insert(em, entry);
      await this.wallets.saveBalance(em, wallet, args.walletVersionBefore);
    }

    await this.outbox.insertAll(
      em,
      eventsForOutcome({
        tx,
        previousStatus: args.previousStatus,
        wallet,
        entry,
        ctx: args.ctx,
      }),
    );
  }
}

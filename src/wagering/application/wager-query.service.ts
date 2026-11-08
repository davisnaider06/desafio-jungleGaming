import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../persistence/database.service';
import { WagerTransactionRepository } from '../../persistence/wager-transaction.repository';
import { NotFoundError } from '../../shared/errors';
import type { MoneyProps } from '../../shared/money';
import { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  failureCode?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

const toView = (tx: WagerTransaction): WagerTransactionView => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  referenceExternalTransactionId: tx.referenceExternalTransactionId,
  referenceTransactionId: tx.referenceTransactionId,
  status: tx.status,
  failureCode: tx.failureCode,
  balance: tx.balanceSnapshot?.toJSON(),
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString(),
});

@Injectable()
export class WagerQueryService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WagerTransactionRepository)
    private readonly txs: WagerTransactionRepository,
  ) {}

  async getById(id: string): Promise<WagerTransactionView> {
    const tx = await this.db.read((em) => this.txs.findById(em, id));
    if (!tx) throw new NotFoundError(`transaction ${id} not found`);
    return toView(tx);
  }

  async getByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ) {
    const tx = await this.db.read((em) =>
      this.txs.findByProviderExternal(em, providerId, externalTransactionId),
    );
    if (!tx) {
      throw new NotFoundError(
        `transaction ${providerId}/${externalTransactionId} not found`,
      );
    }
    return toView(tx);
  }
}

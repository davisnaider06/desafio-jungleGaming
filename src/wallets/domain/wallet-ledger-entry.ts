import { InvalidPayloadError } from '../../shared/errors';
import { Money } from '../../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface WalletLedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Versão da wallet depois deste lançamento. É única por wallet e dá a ordem do extrato. */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

/**
 * Lançamento do ledger. É IMUTÁVEL: todos os campos são readonly e não há
 * métodos de transição. Corrigir um erro = criar um novo lançamento (estorno).
 * O banco reforça isso com um trigger que proíbe UPDATE e DELETE.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: WalletLedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = state.createdAt;
  }

  /** Cria um lançamento novo e confere a aritmética. */
  static create(state: WalletLedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(state);
    if (!entry.money.isPositive()) {
      throw new InvalidPayloadError('ledger entry amount must be positive');
    }
    if (!entry.isBalanced()) {
      throw new InvalidPayloadError('ledger entry is not balanced');
    }
    return entry;
  }

  /** Reconstrói do banco sem revalidar. */
  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito assinado no saldo: +money para crédito, -money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit
      ? this.money
      : this.money.negate();
  }
}

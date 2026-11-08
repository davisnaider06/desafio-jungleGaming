import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../../shared/errors';
import { Money } from '../../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MoveMoneyInput {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate Root da carteira.
 *
 * Regra de ouro: saldo e ledger andam juntos. `debit` e `credit` são os ÚNICOS
 * jeitos de mudar o saldo e cada um devolve o lançamento do ledger que precisa
 * ser gravado na mesma transação SQL.
 *
 * `version` começa em 1 e só sobe quando o saldo muda.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre uma wallet nova. Com saldo inicial > 0, o chamador grava também o lançamento de abertura. */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrói do banco sem revalidar regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Lançamento de abertura (CREDIT do saldo inicial). Só vale logo após `open`,
   * quando ainda estamos na versão 1. Devolve undefined se o saldo inicial é zero.
   */
  openingEntry(args: {
    entryId: string;
    transactionId: string;
  }): WalletLedgerEntry | undefined {
    if (this._version !== 1) {
      throw new InvalidMoneyError(
        'opening entry only exists for a freshly opened wallet',
      );
    }
    if (this._balance.isZero()) return undefined;
    return WalletLedgerEntry.create({
      id: args.entryId,
      walletId: this.id,
      transactionId: args.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: 1,
      createdAt: this.createdAt,
    });
  }

  /** Tira dinheiro. Lança InsufficientFundsError se o saldo não cobre. */
  debit(input: MoveMoneyInput): WalletLedgerEntry {
    this.assertValid(input.money);
    if (this._balance.isLessThan(input.money)) {
      throw new InsufficientFundsError(
        `balance ${this._balance.toString()} is less than ${input.money.toString()}`,
      );
    }
    return this.move(
      LedgerDirection.Debit,
      this._balance.subtract(input.money),
      input,
    );
  }

  /** Coloca dinheiro. */
  credit(input: MoveMoneyInput): WalletLedgerEntry {
    this.assertValid(input.money);
    return this.move(
      LedgerDirection.Credit,
      this._balance.add(input.money),
      input,
    );
  }

  private move(
    direction: LedgerDirection,
    newBalance: Money,
    input: MoveMoneyInput,
  ) {
    const balanceBefore = this._balance;
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = input.at;
    return WalletLedgerEntry.create({
      id: input.entryId,
      walletId: this.id,
      transactionId: input.transactionId,
      direction,
      money: input.money,
      balanceBefore,
      balanceAfter: newBalance,
      walletVersion: this._version,
      createdAt: input.at,
    });
  }

  private assertValid(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError('amount must be greater than zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet currency is ${this.currency}, operation currency is ${money.currency}`,
      );
    }
  }
}

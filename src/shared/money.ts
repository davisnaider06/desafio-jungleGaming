import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Cópia isolada do Decimal: ninguém no processo consegue mudar nossa precisão por engano.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Formato dos contratos (HTTP, fila, eventos): sempre string, nunca number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Só dígitos e ponto: rejeita NaN, Infinity, notação científica ("1e3"), vazio e espaços.
// No máximo 2 casas decimais (aceitamos "10" e "10.5" e normalizamos para "10.00" / "10.50").
const INPUT_AMOUNT = /^\d{1,18}(\.\d{1,2})?$/;
// Valores já guardados podem ser negativos (ex.: diferença da reconciliação).
const STORED_AMOUNT = /^-?\d{1,18}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Toda operação devolve uma instância nova.
 * Usa Decimal (nunca number) para não ter erro de ponto flutuante.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  /** Entrada externa (API, fila): não aceita negativo nem mais de 2 casas. */
  static from(props: MoneyProps): Money {
    return Money.parse(props, INPUT_AMOUNT);
  }

  /** Reidratação de valor que já passou pelo sistema (banco, diferença de reconciliação): aceita negativo. */
  static fromStored(props: MoneyProps): Money {
    return Money.parse(props, STORED_AMOUNT);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new D(0), currency);
  }

  private static parse(props: MoneyProps, pattern: RegExp): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !pattern.test(amount)) {
      throw new InvalidMoneyError(`invalid amount: ${JSON.stringify(amount)}`);
    }
    Money.assertCurrency(currency);
    return new Money(new D(amount), currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`invalid currency: ${JSON.stringify(currency)}`);
    }
  }

  /** Sempre com 2 casas: "25.00". */
  get amount(): string {
    return this.value.toFixed(2);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

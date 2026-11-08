import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normaliza para 2 casas decimais', () => {
    expect(brl('10').amount).toBe('10.00');
    expect(brl('10.5').amount).toBe('10.50');
    expect(brl('0.07').toJSON()).toEqual({ amount: '0.07', currency: 'BRL' });
  });

  test('soma sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('operações são imutáveis', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(a).not.toBe(b);
  });

  test('subtract e negate podem gerar negativo internamente', () => {
    const r = brl('1.00').subtract(brl('3.00'));
    expect(r.amount).toBe('-2.00');
    expect(r.isNegative()).toBe(true);
    expect(r.negate().amount).toBe('2.00');
  });

  test('predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('2.00').equals(brl('2'))).toBe(true);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E3'],
    [''],
    [' '],
    ['10.001'],
    ['1,00'],
    ['-1.00'],
    ['+1.00'],
    ['.5'],
    ['10.'],
    ['abc'],
  ])('rejeita amount inválido %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (number nunca vale para dinheiro)', () => {
    expect(() =>
      Money.from({ amount: 10 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLL'], ['']])(
    'rejeita moeda inválida %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  test('moedas diferentes geram erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('fromStored aceita negativo, from não', () => {
    expect(
      Money.fromStored({ amount: '-5.00', currency: 'BRL' }).isNegative(),
    ).toBe(true);
    expect(() => Money.from({ amount: '-5.00', currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test('valores grandes mantêm precisão exata', () => {
    expect(brl('999999999999999999.99').add(brl('0.01')).amount).toBe(
      '1000000000000000000.00',
    );
  });
});

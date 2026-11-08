import { describe, expect, test } from 'bun:test';
import {
  DriverException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { InsufficientFundsError } from './errors';
import { isTransientInfrastructureError } from './transient-errors';

/** Erro como o `pg` o entrega: `Error` comum, sem `code`. */
const pgError = (message: string) => new Error(message);

describe('isTransientInfrastructureError: erros reais do driver', () => {
  test.each([
    'Connection terminated unexpectedly',
    'Connection terminated',
    'Connection terminated due to connection timeout',
    'Connection ended unexpectedly',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ])('"%s" (sem code) é transitório', (message) => {
    expect(isTransientInfrastructureError(pgError(message))).toBe(true);
  });

  test('o mesmo erro embrulhado em DriverException do MikroORM continua transitório', () => {
    const wrapped = new DriverException(
      pgError('Connection terminated unexpectedly'),
    );
    expect(isTransientInfrastructureError(wrapped)).toBe(true);
  });

  test('erro encadeado em `cause` (sem code em nenhum nível)', () => {
    const outer = new Error('falha ao abrir transação', {
      cause: new Error('Connection terminated unexpectedly'),
    });
    expect(isTransientInfrastructureError(outer)).toBe(true);
  });

  test('ECONNRESET, ECONNREFUSED e 57P01 (por code)', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', '57P01', '57P03']) {
      expect(
        isTransientInfrastructureError(Object.assign(new Error('x'), { code })),
      ).toBe(true);
    }
  });

  test('AggregateError de conexões recusadas (IPv4 + IPv6), mesmo sem code no agregado', () => {
    const refused = () =>
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
    expect(
      isTransientInfrastructureError(
        new AggregateError([refused(), refused()]),
      ),
    ).toBe(true);
  });

  test('a comparação ignora maiúsculas e espaços nas pontas', () => {
    expect(
      isTransientInfrastructureError(
        pgError('  CONNECTION TERMINATED UNEXPECTEDLY '),
      ),
    ).toBe(true);
  });
});

describe('isTransientInfrastructureError: o que NÃO pode ser transitório', () => {
  test('bug de programação continua sendo 500', () => {
    expect(
      isTransientInfrastructureError(new TypeError('x is undefined')),
    ).toBe(false);
    expect(
      isTransientInfrastructureError(
        new RangeError('Maximum call stack size exceeded'),
      ),
    ).toBe(false);
    expect(isTransientInfrastructureError(new Error('boom'))).toBe(false);
  });

  test('mensagem que só PARECE de conexão não conta (comparação é exata, não "contém")', () => {
    for (const message of [
      'connection string is invalid',
      'Connection pool configured with 0 connections',
      'terminated by business rule',
      'Connection terminated unexpectedly while parsing user input',
    ]) {
      expect(isTransientInfrastructureError(new Error(message))).toBe(false);
    }
  });

  test('violação de unicidade, regra de negócio e valores que não são erro', () => {
    expect(
      isTransientInfrastructureError(
        new UniqueConstraintViolationException(new Error('duplicate key')),
      ),
    ).toBe(false);
    expect(
      isTransientInfrastructureError(new InsufficientFundsError('sem saldo')),
    ).toBe(false);
    expect(isTransientInfrastructureError(undefined)).toBe(false);
    expect(isTransientInfrastructureError(null)).toBe(false);
    expect(
      isTransientInfrastructureError('Connection terminated unexpectedly'),
    ).toBe(false);
  });

  test('AggregateError com algum erro NÃO transitório não é transitório', () => {
    const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(
      isTransientInfrastructureError(
        new AggregateError([refused, new TypeError('bug')]),
      ),
    ).toBe(false);
    expect(isTransientInfrastructureError(new AggregateError([]))).toBe(false);
  });
});

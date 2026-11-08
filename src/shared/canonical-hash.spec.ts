import { describe, expect, test } from 'bun:test';
import { canonicalHash, canonicalJson } from './canonical-hash';

describe('canonicalJson', () => {
  test('ordena as chaves em todos os níveis', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      '{"a":{"c":2,"d":1},"b":1}',
    );
  });

  test('mesmo conteúdo em ordem diferente gera o mesmo hash', () => {
    expect(canonicalHash({ x: 1, y: [1, 2] })).toBe(
      canonicalHash({ y: [1, 2], x: 1 }),
    );
  });

  test('conteúdo diferente gera hash diferente', () => {
    expect(canonicalHash({ x: 1 })).not.toBe(canonicalHash({ x: 2 }));
  });

  test('ignora campos undefined', () => {
    expect(canonicalHash({ a: 1, b: undefined })).toBe(canonicalHash({ a: 1 }));
  });
});

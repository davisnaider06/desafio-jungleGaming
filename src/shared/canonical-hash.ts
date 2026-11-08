import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves ordenadas em todos os níveis, sem espaços.
 * Dois objetos com os mesmos dados geram exatamente a mesma string,
 * não importa a ordem em que as chaves chegaram.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** SHA-256 (hex) do JSON canônico. É o `payloadHash` das transações. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

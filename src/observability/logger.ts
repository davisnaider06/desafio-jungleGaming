import type { LoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

/** Troca o destino dos logs (os testes usam isto para capturar linhas). */
export function setLogSink(fn: (line: string) => void): () => void {
  const previous = sink;
  sink = fn;
  return () => {
    sink = previous;
  };
}

function write(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const min = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
  if (ORDER[level] < (ORDER[min] ?? ORDER.info)) return;
  // Uma linha de JSON por evento. Campos úteis para rastrear: correlationId, messageId,
  // transactionId, walletId, providerId. NUNCA colocar valores monetários nem o payload inteiro aqui.
  sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    write('error', msg, fields),
};

/** Faz os logs do próprio Nest também saírem em JSON. */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    logger.info(String(message), { context });
  }
  error(message: unknown, ...rest: unknown[]) {
    logger.error(String(message), {
      context: rest.find((r) => typeof r === 'string'),
    });
  }
  warn(message: unknown, context?: string) {
    logger.warn(String(message), { context });
  }
  debug(message: unknown, context?: string) {
    logger.debug(String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    logger.debug(String(message), { context });
  }
}

/** Só o erro seguro para log: tipo e mensagem, sem stack nem dados. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error)
    return { errorType: error.name, error: error.message };
  return { error: String(error) };
}

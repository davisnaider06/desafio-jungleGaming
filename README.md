# Distributed Wagering Processor

Processador de apostas (BET / WIN / LOSS / REFUND / ROLLBACK) com carteira, ledger imutável, idempotência persistente e mensageria (SQS) com inbox/outbox transacionais.

Stack: **NestJS 12 + Bun**, TypeScript estrito, **MikroORM 7** (Postgres 16), SQS FIFO (MiniStack), `decimal.js` para dinheiro.

As decisões de projeto, o schema e as limitações conhecidas estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.4+
- Docker (Postgres e MiniStack)

## Como subir

```bash
bun install
docker compose up -d          # Postgres (5432) e MiniStack/SQS (4566)
bun run queues:create         # cria wager-transactions.fifo, a DLQ (com RedrivePolicy) e wager-events.fifo
bun run migration:up          # aplica as migrations
bun run start                 # sobe em http://localhost:3000
```

`bun run queues:create` é idempotente (pode rodar de novo). As variáveis de ambiente têm padrões que funcionam com o `docker-compose.yml`; veja `src/config.ts` para a lista (`DB_*`, `AWS_*`, `SQS_*`, `OUTBOX_*`, `PENDING_*`).

Vários processos podem rodar ao mesmo tempo contra o mesmo banco e as mesmas filas (é o cenário suportado). Cada processo roda os workers de outbox, consumidor SQS e `PENDING_REFERENCE`; desligue com `OUTBOX_WORKER=off`, `SQS_CONSUMER=off` ou `PENDING_WORKER=off`.

## Migrations

Geradas pela CLI do MikroORM, com `up` e `down`:

```bash
bun run migration:create      # gera a partir do diff entre as entidades e o banco
bun run migration:up
bun run migration:down
```

## Testes

Os testes usam Postgres e MiniStack **reais** (nada de mock de banco ou fila). Suba o `docker compose` antes. O banco `wagering_test` é criado e migrado automaticamente.

```bash
bun run test               # tudo (use este: ele define o timeout)
bun run test:unit          # domínio puro, sem infraestrutura
bun run test:integration   # HTTP, SQS, outbox, migrations, transações
bun run test:concurrency   # 100/80, 50 apostas idênticas em paralelo, 3 processos reais, kill -9
bun run typecheck
```

Os testes de multi-instância sobem processos reais (`bun src/main.ts`) e matam um com `SIGKILL` no meio do processamento.

## API

```bash
# criar wallet
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# aposta (Idempotency-Key obrigatória)
curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-1:ext-1' \
  -d '{"providerId":"provider-1","externalTransactionId":"ext-1","playerId":"p1",
       "walletId":"<id>","roundId":"r1","gameId":"g1","kind":"BET",
       "money":{"amount":"30.00","currency":"BRL"}}'

# estorno de uma aposta
#   kind = REFUND | ROLLBACK, mais "referenceExternalTransactionId":"ext-1" (mesmo valor da referência)

curl localhost:3000/wallets/<id>                       # saldo
curl 'localhost:3000/wallets/<id>/ledger?limit=20'     # extrato paginado por cursor
curl -X POST localhost:3000/wallets/<id>/reconciliation # confere saldo x ledger
curl localhost:3000/wagering/transactions/<id>
curl localhost:3000/health/live ; curl localhost:3000/health/ready
curl localhost:3000/metrics                            # formato Prometheus
```

Valores monetários são sempre `{ "amount": "30.00", "currency": "BRL" }` com `amount` **string**. Status HTTP: 201 criada, 200 replay/consultas, 202 `PENDING_REFERENCE`, 400 payload inválido, 404, 409 conflito de idempotência, 422 rejeição de negócio (com `failureCode`), 503 indisponibilidade transitória (com `Retry-After`).

## Notas

- **Windows:** `SIGTERM` mata o processo na hora (sem handler). O desligamento gracioso do consumidor é testado dentro do processo (`consumer.stop()`); em Linux/macOS o `enableShutdownHooks` do Nest cobre o sinal real.
- **Autenticação:** não implementada por decisão de escopo; existe o ponto de extensão `src/http/auth.guard.ts` (ver ARCHITECTURE.md).

# Distributed Wagering Processor

Serviço de carteira para iGaming: recebe transações de apostas de provedores de jogos
(`BET` / `WIN` / `LOSS` / `REFUND` / `ROLLBACK`) por HTTP ou por fila SQS e mantém o saldo
do jogador **sempre correto**, mesmo com mensagens duplicadas, fora de ordem, simultâneas
ou com o processo caindo no meio.

**Stack:** NestJS 12 + Bun · TypeScript estrito · MikroORM 7 + PostgreSQL 16 · SQS FIFO (MiniStack) · `decimal.js` para dinheiro.

As decisões de projeto, o schema e as limitações conhecidas estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## O que está garantido

| Garantia | Como |
|---|---|
| Dinheiro exato | `Money` imutável com `decimal.js`; `amount` sempre string; `NUMERIC(20,2)` no banco. Nunca `number`. |
| Saldo nunca negativo | lock pessimista por wallet (`SELECT ... FOR UPDATE`) + `CHECK (balance >= 0)` no banco |
| Sem débito/crédito duplicado | `Idempotency-Key` única no banco + hash canônico do payload + inbox para mensagens da fila |
| Ledger auditável | extrato append-only (trigger impede UPDATE/DELETE); saldo conferível por reconciliação |
| Evento nunca antes do commit | transactional outbox, publicado por worker com `FOR UPDATE SKIP LOCKED` |
| Várias instâncias | lock e unicidade ficam no banco; testado com 3 processos reais e `kill -9` |
| Entrega fora de ordem | `PENDING_REFERENCE` + worker com backoff exponencial |

## Pré-requisitos

- [Bun](https://bun.sh) 1.4+
- Docker (Postgres e MiniStack)

## Como subir

```bash
bun install
docker compose up -d --wait   # Postgres (5432) e MiniStack/SQS (4566); espera ficarem saudáveis
bun run queues:create         # cria wager-transactions.fifo, a DLQ (com RedrivePolicy) e wager-events.fifo
bun run migration:up          # aplica as migrations
bun run start                 # API em http://localhost:3000
```

`bun run queues:create` é idempotente e espera o SQS responder antes de criar as filas.
As variáveis de ambiente têm padrões que funcionam com o `docker-compose.yml`; a lista está em
`src/config.ts` (`DB_*`, `AWS_*`, `SQS_*`, `OUTBOX_*`, `PENDING_*`).

Vários processos podem rodar ao mesmo tempo contra o mesmo banco e as mesmas filas (é o cenário
suportado). Cada processo roda os workers de outbox, consumidor SQS e `PENDING_REFERENCE`;
desligue com `OUTBOX_WORKER=off`, `SQS_CONSUMER=off` ou `PENDING_WORKER=off`.

> **Por que MiniStack e não LocalStack:** a imagem atual do LocalStack só inicia com token de conta.
> O MiniStack (aceito pelo desafio) é a mesma API da AWS na porta 4566, sem conta, então qualquer
> pessoa sobe o projeto com um comando.

## Testes automatizados

Os testes usam Postgres e MiniStack **reais** (nada de mock de banco ou fila). Suba o
`docker compose` antes. O banco `wagering_test` é criado e migrado automaticamente.

```bash
bun run test               # tudo (use este: ele define o timeout)
bun run test:unit          # domínio puro, sem infraestrutura
bun run test:integration   # HTTP, SQS, outbox, migrations, transações
bun run test:concurrency   # 100/80, 50 apostas idênticas em paralelo, 3 processos reais, kill -9
bun run typecheck
bun run lint
```

Os testes de multi-instância sobem processos reais (`bun src/main.ts`) e matam um com `SIGKILL`
no meio do processamento. Todo teste de integração termina conferindo a invariante
`saldo da wallet == saldo reconstruído pelo ledger`.

## Prova de Fogo (teste manual adversarial)

Testes automatizados provam o que alguém pensou em testar. A Prova de Fogo é um painel para
**tentar quebrar o serviço de propósito**, do jeito que um provedor com bug, uma rede instável
ou um atacante fariam.

```bash
# com a API rodando, em outro terminal:
bun run fogo
# abra http://localhost:4000
```

Cada ataque mostra um **raio-x** completo:

1. **o risco**: o que daria errado no mundo real sem a defesa;
2. **o ataque**: cada requisição enviada (corpo, `Idempotency-Key`, status, tempo e resposta);
3. **o estado final do banco**: saldo, versão da wallet, extrato linha a linha e reconciliação;
4. **o veredito**: esperado × obtido;
5. **a defesa**: qual camada segurou, com o arquivo e a constraint exatos no código.

### Ataques de aplicação

| Ataque | O que tenta |
|---|---|
| Fluxo feliz | BET, WIN e LOSS na ordem certa (linha de base) |
| Duplo clique | a mesma aposta duas vezes com a mesma chave |
| Clique frenético | a mesma aposta 50× em paralelo |
| Chave reaproveitada | mesma `Idempotency-Key` com outro valor |
| Corrida 100/80 | duas apostas de 80 simultâneas com saldo 100 |
| Hot wallet | 60 apostas diferentes de 1.00 com saldo 40.00 |
| Dinheiro inválido | `25` como number, `1e3`, `-1.00`, `10.001`, vazio, texto, zero |
| Payload malicioso | `OPENING` pela API, `kind` inventado, sem chave, JSON quebrado |
| Moeda e dono errados | USD numa wallet BRL; player que não é o dono |
| Wallet duplicada | mesmo player e moeda duas vezes |
| Reversão dupla | REFUND e depois ROLLBACK da mesma BET |
| Reversão adulterada | REFUND com valor ou rodada diferentes da BET |
| Fora de ordem | REFUND chegando antes da BET |

### Ataques de infraestrutura

| Ataque | O que tenta |
|---|---|
| Banco cai no meio | para o Postgres, aposta (espera 503), sobe e reenvia com a mesma chave |
| Aposta pela fila | publica na SQS e depois a **mesma** mensagem de novo |
| Lixo na fila | mensagem inválida antes de uma válida: deve ir para a DLQ sem travar a fila |

Os de infraestrutura executam ações fixas via `docker compose` (nada vindo do navegador vira
comando); o servidor do painel escuta só em `127.0.0.1`.

### O que ela encontrou

Com os 185 testes automatizados passando, a Prova de Fogo ainda achou **três problemas reais**,
corrigidos e registrados no ARCHITECTURE.md (§11):

- **Setup quebrava em sequência rápida:** `queues:create` falhava com `socket hang up` porque o
  MiniStack ainda iniciava. Correção: healthchecks, `docker compose up -d --wait` e espera ativa
  pelo SQS no script.
- **Workers sem backoff em erro:** com a fila indisponível, o consumidor tentava a cada ~60 ms e
  gerava centenas de logs por segundo. Correção: backoff exponencial até 30 s e log só ao entrar
  em falha e ao se recuperar.
- **Banco caindo de verdade devolvia 500 em vez de 503:** com o Postgres parado, o driver lança um
  `Error` sem `code` ("Connection terminated unexpectedly") que o classificador de falhas
  transitórias não reconhecia; o teste antigo só injetava uma exceção conhecida. Correção: o
  classificador reconhece as mensagens de conexão do `pg`, e um teste novo derruba a conexão de
  verdade (proxy TCP) e prova 503, `Retry-After`, nada gravado e um único débito no reenvio.

Detalhes em [tools/prova-de-fogo/README.md](tools/prova-de-fogo/README.md).

## API

> Os exemplos abaixo são para **bash** (Linux, macOS, Git Bash). No PowerShell, o `curl` puro é um
> apelido do `Invoke-WebRequest` e as aspas simples do JSON não funcionam: use `curl.exe` com o JSON
> entre aspas duplas (escapando as internas) ou `Invoke-RestMethod`, por exemplo:
>
> ```powershell
> Invoke-RestMethod -Method Post http://localhost:3000/wallets -ContentType 'application/json' `
>   -Body '{"playerId":"p1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
> ```

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

curl localhost:3000/wallets/<id>                        # saldo
curl 'localhost:3000/wallets/<id>/ledger?limit=20'      # extrato paginado por cursor
curl -X POST localhost:3000/wallets/<id>/reconciliation # confere saldo x ledger
curl localhost:3000/wagering/transactions/<id>
curl localhost:3000/providers/<providerId>/wagering/transactions/<externalTransactionId>
curl localhost:3000/health/live ; curl localhost:3000/health/ready
curl localhost:3000/metrics                             # formato Prometheus
```

Valores monetários são sempre `{ "amount": "30.00", "currency": "BRL" }`, com `amount` **string**.

| Status | Quando |
|---|---|
| 201 | transação processada pela primeira vez; wallet criada |
| 200 | replay idempotente; consultas |
| 202 | `PENDING_REFERENCE` (aceito, aguardando a referência) |
| 400 | payload inválido ou header ausente |
| 404 | recurso inexistente |
| 409 | conflito de idempotência; wallet já existe |
| 422 | rejeição de regra de negócio (com `failureCode`) |
| 503 | indisponibilidade transitória (com `Retry-After`; reenviar com a mesma chave é seguro) |

## Problemas comuns

- **`Cannot find module ...` logo depois do `bun install`:** o cache do Bun pode estar corrompido
  e ter instalado pacotes vazios. Limpe o cache e instale de novo:

  ```bash
  bun pm cache rm
  bun install
  ```

- **`queues:create` falha com `socket hang up`:** o MiniStack ainda estava iniciando. Suba com
  `docker compose up -d --wait`; o script também espera o SQS responder por até 30 s.
- **`port is already allocated` (4566 ou 5432):** outro contêiner ou clone do projeto está usando
  a porta. Rode `docker ps` e pare o outro (`docker compose down` na pasta dele).

## Notas

- **Windows:** `SIGTERM` mata o processo na hora (sem handler). O desligamento gracioso do
  consumidor é testado dentro do processo (`consumer.stop()`); em Linux/macOS o
  `enableShutdownHooks` do Nest cobre o sinal real.
- **Autenticação:** não implementada por decisão de escopo; existe o ponto de extensão
  `src/http/auth.guard.ts` (ver ARCHITECTURE.md §13).

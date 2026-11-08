# Desafio Jungle Gaming — Distributed Wagering Processor

Checklist completo dos requisitos do README oficial
(https://github.com/junglegaming/backend-challenge), organizado para implementar e conferir.
Em caso de dúvida, **o README oficial manda**. Este arquivo é o mapa de trabalho.

**Prazo:** 3 dias a partir do e-mail de 06/11 às 18h26 → **segunda 09/11, 18h26**.
Meta: entregar **segunda até 15h**. Entrega pelo link do e-mail; em caso de erro, por e-mail.

Legenda de prioridade: **[E]** = evita falha eliminatória · **[P1]** · **[P2]** · **[P3]** · **[OPC]** opcional/diferencial

---

## 0. O que eles avaliam (seção 1)

Não avaliam CRUD nem "saber NestJS por cima". Avaliam:
- [ ] correção financeira
- [ ] concorrência entre múltiplas instâncias
- [ ] idempotência persistente
- [ ] consistência entre saldo materializado e ledger
- [ ] processamento assíncrono e recuperação após falhas
- [ ] clareza das decisões técnicas

O sistema tem que continuar correto quando mensagens chegam **duplicadas**, **fora de ordem**
ou **ao mesmo tempo**. "Raciocínio claro, código limpo e decisões justificadas" — as decisões
serão **discutidas na apresentação**.

---

## 1. Autenticação (seção 2) — vale 0 pontos

- [ ] **Decisão:** não implementar (recomendado pelo prazo).
- [ ] Se NÃO implementar:
  - [ ] documentar a decisão no `ARCHITECTURE.md`
  - [ ] descrever o desenho que adotaria (IdP externo, ex.: Keycloak ou Zitadel, OIDC)
  - [ ] deixar ponto de extensão explícito no código (ex.: `AuthGuard` no-op ou `ProviderIdentityPort`)
- [ ] Se implementar: **IdP externo** (Keycloak/Zitadel ou equivalente). **Proibido** tabela própria de usuários com hash de senha.
- [ ] Endpoints de health ficam **abertos**.
- [ ] Mensagens da fila = canal interno confiável, **mas** o `providerId` dentro da mensagem passa pelas mesmas validações de domínio.

---

## 2. Domínio (seção 3)

Fluxo de uma rodada: `BET → WIN | LOSS | REFUND | ROLLBACK`. Entrega **at-least-once**. Assumir que:
- [x] a mesma operação pode chegar várias vezes
- [x] uma operação dependente pode chegar **antes** da referenciada
- [x] várias instâncias podem tocar a mesma wallet ao mesmo tempo
- [x] o processo pode morrer **antes ou depois** do commit
- [x] eventos podem ser publicados mais de uma vez
- [x] PostgreSQL e SQS podem ficar temporariamente indisponíveis

**Invariantes globais [E]:** nunca duplicar crédito · nunca duplicar débito · nunca perder evento confirmado · nunca saldo negativo.

---

## 3. Stack (seção 4)

| Item | Obrigatório |
|---|---|
| Runtime / package manager / **test runner** | **Bun 1.x** (`bun test`) |
| Linguagem | TypeScript **strict** |
| Framework | NestJS |
| Banco | PostgreSQL |
| Mensageria | AWS SQS via **LocalStack** ou MiniStack |
| Orquestração local | Docker Compose |
| Migrations | **versionadas e reversíveis** (up e down) |

- [x] ORM: **MikroORM** (preferido: Unit of Work, Identity Map, `em.transactional()`, `LockMode`). TypeORM aceito. **Prisma proibido.**
- [ ] Justificar no `ARCHITECTURE.md`: escolha do ORM, **mapeamento do `Money`** e **estratégia transacional**.

---

## 4. Restrições invioláveis (seção 5)

- [x] [E] 1. Nada de `number`, `float` ou `double` para dinheiro.
- [x] [E] 2. Nada de cache em memória como garantia de idempotência.
- [x] 3. Não confiar só no SQS FIFO para consistência.
- [x] [E] 4. Não publicar evento antes do commit da transação financeira.
- [x] 5. Não sobrescrever nem excluir lançamentos do ledger.
- [x] 6. Não usar lock global compartilhado por todas as wallets.
- [x] 7. Não fazer saldo como `read → calculate → update` sem controle de concorrência.
- [x] [E] 8. Correto com **múltiplas instâncias**.
- [x] 9. Unicidade, imutabilidade e não-negatividade garantidas **no schema do banco** (constraints, índices). O desenho do schema é avaliado.

---

## 5. Modelo de domínio (seção 6)

### 5.0 Regra de modelagem (todas as classes de domínio)
- [x] Construtor `private` ou `protected` + factories estáticas (`create`, `from`, `rehydrate`).
- [x] `rehydrate` reconstrói do banco **sem revalidar** regras de transição.
- [x] Estado encapsulado, transições explícitas. Nomes podem mudar se as garantias forem preservadas.

### 5.1 `Money` [P1][E]
- [x] `interface MoneyProps { amount: string; currency: string }` (DTO)
- [x] Construtor privado com `Decimal` + `currency`
- [x] `static from(props: MoneyProps)` · `static zero(currency)`
- [x] `add` · `subtract` · `negate`
- [x] `isZero` · `isPositive` · `isNegative` · `isLessThan` · `equals`
- [x] `toJSON(): MoneyProps` · `toString()`
- [x] `private assertSameCurrency(other)`
- [x] **Imutável**: toda operação retorna instância nova.
- [x] `amount` recebido e serializado como **string decimal com escala fixa de 2 casas**.
- [x] Moedas diferentes → **erro de domínio**.
- [x] Rejeitar entrada: `NaN`, `Infinity`, notação científica, string vazia, **mais de 2 casas**, **negativo em contrato de entrada**.
- [x] Domínio **não depende** de tipos do ORM nem de decorators do Nest.
- [x] Persistência: valor e moeda podem ser colunas separadas, desde que exato e reidratado como `Money`.
- [x] Pode assumir só `BRL`, **mas** o modelo continua multimoeda e **conflito de moeda é testado**.
- [x] Formato nos contratos: `{ "amount": "25.00", "currency": "BRL" }`

### 5.2 `Wallet` (Aggregate Root) [P1]
- [x] Campos: `id`, `playerId`, `currency`, `_balance: Money`, `_version: number`, `createdAt`, `_updatedAt`
- [x] `static open({ id, playerId, initialBalance })` · `static rehydrate(state)`
- [x] getters `balance`, `version`, `updatedAt`
- [x] `debit(...)` e `credit(...)` mantendo saldo e ledger consistentes (assinatura/retorno à sua escolha)
- [x] `private assertSameCurrency`
- Invariantes:
  - [x] no máximo **uma wallet por `playerId` + `currency`** (unique no banco)
  - [x] saldo nunca negativo (check no banco)
  - [x] **toda alteração de saldo tem lançamento no ledger e vice-versa**
  - [x] concorrência não causa lost update
  - [x] moeda da operação = moeda da wallet
  - [x] `version` começa em **1** após criar e **só incrementa quando o saldo muda**
- [x] `version` sugerido para optimistic lock; outra estratégia ok se justificada.

### 5.3 `WagerTransaction` [P1]
- [x] `enum WagerTransactionKind`: `OPENING` (interno), `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`
- [x] `enum WagerTransactionStatus`: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`
- [x] Campos: `id`, `providerId`, `externalTransactionId`, `idempotencyKey`, `payloadHash`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId` (id do provedor), `createdAt`, `_status`, `_referenceTransactionId?`, `_failureCode?`, `_processedAt?`
- [x] `static create(props)` — nasce `PENDING`, valida exigência de referência por kind
- [x] `static rehydrate(state)`
- [x] getters `status`, `referenceTransactionId`, `failureCode`, `processedAt`
- [x] Transições: `markProcessed(referenceTransactionId, at)` · `markPendingReference()` · `reject(code)` · `fail(code)`
- [x] Transição a partir de estado terminal → lança `InvalidTransactionStateError` (erro de programação)
- [x] Consultas: `isTerminal()` · `affectsBalance()` (false para LOSS) · `requiresReference()` (REFUND e ROLLBACK) · `matchesPayload(hash)` · `ledgerDirectionFor(reference?)`
- [x] `PROCESSED`, `REJECTED`, `FAILED` são **terminais**
- [ ] **Definir e documentar** as transições válidas (diagrama de estados no ARCHITECTURE.md)
- [x] `OPENING` **não pode** ser submetido pela API nem pela fila
- [x] Mesma idempotency key + payload diferente = **conflito**, não replay

### 5.4 `WalletLedgerEntry` (imutável) [P1][E]
- [x] `enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }`
- [x] Campos (todos readonly): `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `createdAt`
- [x] `static create(props)` valida a aritmética · `static rehydrate(state)`
- [x] `isBalanced()`: `balanceBefore ± money === balanceAfter`
- [x] **Sem campos mutáveis e sem métodos de transição**
- [x] No máximo **um lançamento por transação por wallet** (unique no banco)
- [x] `LOSS` e transação `REJECTED` **não geram** lançamento
- [ ] [OPC] partidas dobradas (double-entry)

### 5.5 Inbox e Outbox [P2]
- [x] `InboxMessage`: `messageId`, `consumerName`, `payloadHash`, `receivedAt`, `_processedAt?` · `receive`, `rehydrate`, `isProcessed`, `markProcessed(at)`
- [x] `OutboxMessage`: `id`, `aggregateId`, `eventType`, `payload` (readonly record), `occurredAt`, `_attempts`, `_nextAttemptAt?`, `_publishedAt?` · `enqueue(event)`, `rehydrate`, getters, `isPending`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)` (incrementa attempts + backoff)
- [x] [E] Inbox + alteração financeira + ledger + outbox na **mesma transação SQL**

---

## 6. Regras de negócio (seção 7)

| Operação | Saldo | Ledger | Regra |
|---|---|---|---|
| BET | débito | 1 DEBIT | rejeita se saldo insuficiente |
| WIN | crédito | 1 CREDIT | pode referenciar a BET da mesma rodada |
| LOSS | nenhum | nenhum | registra resultado sem mover saldo |
| REFUND | crédito | 1 CREDIT | reverte uma BET `PROCESSED`, uma única vez |
| ROLLBACK | inverso da referência | 1 invertida | reverte transação `PROCESSED`, uma única vez |

- [x] [P1] BET, WIN, LOSS
- [x] [P3] REFUND, ROLLBACK
- [x] 1. REFUND e ROLLBACK exigem `referenceExternalTransactionId`
- [x] 2. Referência resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do **mesmo provider, player, wallet, moeda e rodada**
- [x] 3. REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND
- [x] 4. Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação (constraint no banco)
- [x] 5. Valor de REFUND/ROLLBACK **igual** ao da referência (parcial fora de escopo)
- [x] 6. `REJECTED` não altera saldo nem gera ledger
- [x] 7. Repetir operação já processada retorna **o resultado original, incluindo o saldo daquele momento**
- [x] 8. Referência ausente → `PENDING_REFERENCE` e reprocessar depois
- [x] 9. Reversão que deixaria saldo negativo → **rejeitada explicitamente** com `failureCode` **diferente** do de BET sem saldo, auditável
- [ ] Documentar qualquer interpretação adicional

### 6.1 Fora de ordem [P3]
- [x] Worker agendado reprocessa `PENDING_REFERENCE` com **backoff exponencial**
- [x] Limite de tentativas ou TTL **definido e justificado**
- [x] Esgotou → `REJECTED` com `failureCode` de referência inexistente + **evento publicado**

### 6.2 Códigos de falha [P1]
- [x] Toda rejeição tem `failureCode` estável e legível por máquina
- [ ] Taxonomia própria, **documentada**, suficiente para o provedor decidir: reenviar, corrigir payload ou desistir
- Sugestão: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `CURRENCY_MISMATCH`, `WALLET_NOT_FOUND`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `INVALID_REFERENCE_KIND`, `IDEMPOTENCY_CONFLICT`, `INVALID_PAYLOAD`

---

## 7. Concorrência (seção 8) [P1][E]

- [x] Unidade de concorrência = `walletId`
- [ ] Correto quando: duas apostas disputam o mesmo saldo · vários workers na mesma wallet · wallets diferentes em paralelo · **3+ instâncias**
- [ ] Estratégia escolhida e **justificada** (pessimista, otimista com retry limitado, update atômico condicionado ou combinação)
- [x] Recursos do broker (FIFO, dedup) = otimização; **o banco garante as invariantes**
- [x] **Cenário obrigatório:** saldo 100.00, duas BETs de 80.00 simultâneas →
  - [x] exatamente uma `PROCESSED`
  - [x] a outra `REJECTED` por saldo insuficiente
  - [x] saldo final `20.00`
  - [x] exatamente **um** débito no ledger
  - [x] nenhum retry duplica o débito

---

## 8. API HTTP (seção 9) [P1]

### Criar wallet
- [x] `POST /wallets` com `{ playerId, initialBalance: { amount, currency } }`
- [x] Saldo inicial > 0 → transação interna `OPENING` + lançamento `CREDIT` **na mesma transação SQL**
- [x] Resposta: `{ id, playerId, balance: {amount, currency}, version: 1 }`
- [x] Duplicada (mesmo `playerId` + `currency`) → **conflito**

### Consultas
- [x] `GET /wallets/:walletId`
- [x] `GET /wallets/:walletId/ledger?cursor=...&limit=50` — cursor **estável e opaco**
- [x] `GET /wagering/transactions/:transactionId`
- [x] `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

### Submeter transação
- [x] `POST /wagering/transactions` com header `Idempotency-Key`
- [x] Body: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (+ `referenceExternalTransactionId` em REFUND/ROLLBACK)
- [x] Resposta: `{ transactionId, status, balance, idempotentReplay }`
- Idempotência [E]:
  - [x] header **obrigatório** e é a fonte da verdade
  - [x] padrão recomendado: `"{providerId}:{externalTransactionId}"`
  - [x] `payloadHash` = hash de **JSON canônico** (chaves ordenadas) só dos campos de negócio; header e metadados de transporte **não entram**; **algoritmo documentado**
  - [x] requisição idêntica → mesma resposta com `idempotentReplay: true`
  - [x] mesma key + payload diferente → **conflito**, não replay

### Status HTTP
- [ ] Mapeamento seu, mas **consistente em todos os endpoints**, distinguindo:
  - [x] payload inválido (sugestão 400/422)
  - [x] conflito de idempotência (409)
  - [x] rejeição por regra de negócio (sugestão 422, ou 200 com `status: REJECTED` — decidir e documentar)
  - [x] aceite com processamento pendente (202)
  - [x] falha transitória de infraestrutura (503)
- [ ] Documentar a tabela no ARCHITECTURE.md

### Reconciliação
- [x] `POST /wallets/:walletId/reconciliation`
- [x] Resposta: `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`
- [x] Divergência **não é corrigida silenciosamente**: logada, contada em métrica e sinalizada na resposta

### Health [P1]
- [x] `GET /health/live` — processo vivo
- [x] `GET /health/ready` — PostgreSQL **e** SQS alcançáveis
- [x] Sem autenticação

---

## 9. SQS (seção 10) [P2]

- [x] Filas: `wager-transactions.fifo` e `wager-transactions-dlq.fifo`
- [x] Mensagem: `{ messageId, type: "WagerTransactionRequested", occurredAt, data: {...mesmos campos + idempotencyKey} }`
- Consumidor:
  - [x] reutiliza **o mesmo use case** do HTTP
  - [x] deduplica via **inbox persistente** por `(consumerName, messageId)`
  - [x] **ack (DeleteMessage) só depois do commit**
  - [x] distingue erros: **negócio** (terminal → ack) · **transitório** (retry com backoff) · **permanente** (DLQ)
  - [x] limite de tentativas antes da DLQ
  - [x] em `SIGTERM`: conclui as mensagens em andamento ou devolve a visibilidade
  - [x] redelivery sem duplicar efeito

---

## 10. Transactional Outbox (seção 11) [P2][E]

- [x] Transação + saldo + ledger + inbox (se veio da fila) + evento = **atômicos**
- [x] Worker publica pendentes; funciona com **vários publishers concorrentes** sem perder nem duplicar indefinidamente (dica: `FOR UPDATE SKIP LOCKED`)
- [x] Cenário: commit → processo morre antes de publicar → outra instância assume → publica → publicação duplicada continua segura para o consumidor
- Eventos mínimos:
  - [x] `WagerTransactionProcessed` — qualquer aplicada, **inclusive LOSS**
  - [x] `WagerTransactionRejected` — rejeitada por regra de negócio
  - [x] `WalletBalanceChanged` — **somente** quando o saldo muda
  - [x] `WagerTransactionPendingReference` — referência ausente
- Envelope:
  - [x] `abstract class IntegrationEvent<T>` com `abstract eventType`, `abstract version`, `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`, `data: Readonly<T>`, construtor `protected`
  - [x] `toJSON()` → `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt (ISO-8601), version, data }`
  - [x] **Uma subclasse concreta por evento**, com `eventType` e `version` no tipo (não string solta)
  - [x] Ex.: `WalletBalanceChanged` com `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` + `static from(wallet, entry, ctx)`
  - [x] `data` carrega `MoneyProps` (string), **nunca** a instância de `Money`

---

## 11. Observabilidade (seção 12) [P2]

- [x] Logs **JSON** com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`
- [x] Sem dados sensíveis nem payload financeiro completo nos logs
- [x] Métricas: transações por status · duplicatas detectadas · retries · mensagens em DLQ · conflitos de lock · outbox lag · latência de processamento
- [x] Health separado: liveness e readiness
- [ ] [OPC] OpenTelemetry e dashboard

---

## 12. Testes obrigatórios (seção 13)

### Unidade [P1]
- [x] `Money`: escala, arredondamento, entradas inválidas
- [x] invariantes da `Wallet`
- [x] regras de BET, WIN, LOSS, REFUND, ROLLBACK
- [x] conflito de moeda
- [x] idempotency key com payload divergente

### Integração — Postgres e LocalStack **reais em containers** [E]
- [x] migrations e constraints
- [x] atomicidade entre wallet, ledger, inbox e outbox
- [x] inbox e redelivery
- [x] publishers concorrentes na mesma outbox
- [x] retry e DLQ
- [x] recuperação após reinicialização

### Concorrência — paralelismo real, não mock sequencial
- [x] 1. mesma aposta **50 vezes em paralelo** → um único débito
- [x] 2. cenário 100/80
- [x] 3. wallets distintas em paralelo
- [x] 4. **≥ 3 processos/instâncias** simultâneos
- [x] 5. worker morto **depois do commit e antes do ack**
- [x] 6. dois publishers na mesma outbox
- [x] 7. ROLLBACK ou REFUND entregue antes da referência
- [x] 8. reinício do serviço com consistência final comprovada

- [x] **Invariante final em todos os testes:** `wallet.balance == saldo reconstruído pelo ledger`

---

## 13. Avaliação (seção 14) — 100 pontos

| Área | Pts | O que olham |
|---|---|---|
| Correção financeira | 20 | Money, saldo, ledger, reversões, reconciliação |
| Concorrência | 20 | lost update, hot wallet, múltiplas instâncias, locks |
| Idempotência | 15 | dedup persistente, replay, payload conflitante |
| Mensageria e falhas | 15 | inbox, outbox, retry, DLQ, crash recovery, shutdown |
| Modelagem e arquitetura | 10 | invariantes em classes, boundaries, portas, simplicidade |
| Testes | 10 | integração real, races, determinismo, falhas |
| Observabilidade | 5 | logs, métricas, health, diagnóstico |
| Documentação | 5 | README + ARCHITECTURE.md |

### Falhas eliminatórias [E]
- [x] `number` para dinheiro
- [x] saldo negativo por race
- [x] débito ou crédito duplicado
- [x] idempotência só em memória
- [ ] correto só com uma instância
- [ ] evento publicado antes do commit
- [x] sem ledger auditável
- [ ] testes que trocam **completamente** PostgreSQL e SQS por mocks

### Diferencial [OPC]
- [ ] Teste de carga em `bun run test:load` registrando: ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência, outbox lag. Sem meta de RPS; vale a honestidade da análise.

---

## 14. Entregáveis

### `README.md`
- [ ] Pré-requisitos (Bun, Docker)
- [ ] Como subir (`docker compose up -d`, migrations, `bun run start`)
- [ ] Como rodar cada suíte de teste
- [ ] Exemplos de chamadas (curl)

### `ARCHITECTURE.md` — tudo que o README oficial manda justificar
- [ ] Escolha do ORM
- [ ] Mapeamento do `Money` na persistência
- [ ] Estratégia transacional
- [ ] Estratégia de concorrência e por quê
- [ ] Decisão sobre autenticação + desenho alternativo + ponto de extensão
- [ ] Diagrama/tabela de transições de status da `WagerTransaction`
- [ ] Taxonomia de `failureCode`
- [ ] Algoritmo do `payloadHash`
- [ ] Limite/TTL do `PENDING_REFERENCE` e justificativa
- [ ] Mapeamento de status HTTP
- [ ] Schema: constraints e índices e o que cada um garante
- [ ] Interpretações adicionais das regras
- [ ] Trade-offs e **limitações conhecidas** (o que não deu tempo e como faria)
- [ ] Uso de IA no desenvolvimento e como o código foi validado (a vaga cita isso)

---

## 15. Plano de execução

**Sexta à noite (hoje)**
1. Instalar Bun, Docker, Git; criar repo público no GitHub
2. `docker-compose.yml` com Postgres + LocalStack (+ criação das filas FIFO e DLQ)
3. Projeto Nest rodando com Bun + `GET /health/live`

**Sábado — P1 completa**
4. `Money` + testes unitários
5. Entidades/schema MikroORM + migrations reversíveis + constraints
6. `Wallet` + `WalletLedgerEntry` + `POST /wallets` com OPENING
7. `WagerTransaction` + BET/WIN/LOSS + failureCodes
8. Lock por wallet + teste 100/80 + 50 em paralelo
9. Idempotency-Key + payloadHash + replay/conflito
10. GETs + reconciliação + `GET /health/ready`

**Domingo — P2 (+ P3 se der)**
11. Outbox + eventos + worker com `SKIP LOCKED`
12. Consumer SQS + inbox + ack após commit + DLQ + SIGTERM
13. Teste com 3 instâncias
14. Logs JSON + métricas
15. REFUND/ROLLBACK + PENDING_REFERENCE worker

**Segunda até 15h**
16. Clonar o repo do zero numa pasta nova e rodar tudo seguindo só o README
17. Finalizar README e ARCHITECTURE.md
18. Revisar este checklist inteiro e entregar
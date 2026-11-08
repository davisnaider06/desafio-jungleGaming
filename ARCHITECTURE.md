# ARCHITECTURE

Este documento registra **o que foi decidido e por quê**. Quando havia mais de um caminho, escolhi o mais simples que cumpre o requisito. Setup e comandos estão no [README](README.md).

## 1. Visão geral

```
HTTP ──┐                                         ┌── wallets / wallet_ledger_entries
       ├─> ProcessWagerTransactionUseCase ──tx──>├── wager_transactions
SQS ───┘   (inbox se veio da fila)               ├── inbox_messages
                                                 └── outbox_messages ──> OutboxPublisher ──> SQS (wager-events.fifo)
PENDING_REFERENCE worker ──> mesma regra de negócio (processWager)
```

- **Domínio puro** (`src/wagering/domain`, `src/wallets/domain`, `src/messaging/domain`): sem Nest, sem ORM. `processWager` decide tudo (BET/WIN/LOSS/REFUND/ROLLBACK) e é coberto por testes unitários.
- **Aplicação** (`*/application`): abre a transação, trava a wallet, chama o domínio, grava o resultado (`OutcomeWriter`).
- **Persistência** (`src/persistence`): repositórios MikroORM + SQL cru onde o ORM atrapalharia (`ON CONFLICT`, `SKIP LOCKED`).
- **Mensageria** (`src/messaging`) e **workers** (`src/workers`): publisher da outbox, consumidor SQS e worker de `PENDING_REFERENCE`, todos seguros para rodar em várias instâncias.

HTTP e fila usam **o mesmo caso de uso** (`execute` / `executeFromQueue`); a única diferença é o registro no inbox.

## 2. Escolhas de tecnologia

### ORM: MikroORM (sem decorators)
Pedido do desafio era evitar Prisma. MikroORM tem `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`), migrations geradas pela CLI com `up`/`down` e `EntitySchema`, que permite descrever as tabelas **sem decorators** (o Bun não tem `emitDecoratorMetadata`). O domínio não conhece o ORM: os repositórios convertem registro ↔ objeto de domínio.

### Mapeamento do `Money`
`Money` é imutável, baseado em `decimal.js`, com escala 2 e moeda. **Nunca `number`.** No banco: `NUMERIC(20,2)` + `CHAR(3)`; na API e nos eventos: `{ "amount": "30.00", "currency": "BRL" }` com `amount` string. `Money.from` rejeita negativo (entrada de usuário); `Money.fromStored` aceita (para reconstruir diferenças na reconciliação).

### Estratégia transacional
Uma operação financeira é **uma transação SQL** que contém: (inbox, se veio da fila) + transação de aposta + wallet + lançamento no ledger + eventos na outbox. Ou tudo é confirmado, ou nada. Evento só é publicado no SQS **depois** do commit, pelo publisher (padrão transactional outbox). `Database.transaction` abre o `EntityManager` da operação.

> **Armadilha encontrada:** `em.getConnection().execute()` roda **fora** da transação do `em` (usa outra conexão do pool); só `em.execute()` participa dela. Um teste flaky de multi-instância (239/240 apostas) revelou isso nos repositórios de inbox/outbox. Corrigido para `em.execute()` e travado em `test/integration/transactions.spec.ts`, que falha com o código antigo.

## 3. Concorrência

**Estratégia: lock pessimista por wallet (primária) + garantias do banco como rede de segurança.**

1. Toda mudança de saldo faz `SELECT ... FOR UPDATE` na linha da wallet. Duas apostas na mesma wallet se enfileiram no Postgres; wallets diferentes não se bloqueiam. Funciona com N instâncias porque o lock está no banco, não na memória.
2. Rede de segurança: `unique(wallet_id, wallet_version)` no ledger, `UPDATE ... WHERE version = :esperada` e `CHECK (balance >= 0)`. Se algo passar pelo lock, o banco recusa; o caso de uso tenta de novo até 3 vezes em `UniqueConstraintViolation`/`WalletVersionConflict`.
3. **Por que pessimista e não otimista:** uma wallet "quente" teria muitos conflitos e retries; o lock enfileira sem desperdiçar trabalho. É também mais simples de explicar.
4. A checagem de idempotência é **repetida depois do lock**, porque outra requisição igual pode ter terminado enquanto esta esperava.

**Achado de teste de mutação:** removendo o lock, só o teste da wallet quente quebrou. As redes de segurança do banco mascaram o caso "100/80" (uma das apostas simplesmente falhava/refazia e o resultado final continuava correto). Por isso existe também o teste "100/80 em 25 wallets" e o da wallet quente. Conclusão: o lock é o mecanismo, as constraints são a defesa em profundidade, e **nenhum dos dois substitui o outro**.

Prova por teste: 100/80 concorrentes, 50 apostas idênticas em paralelo, wallets distintas em paralelo, mistura BET/WIN e **3 processos reais** contra o mesmo banco e a mesma fila (um deles morto com `kill -9` no meio do processamento).

## 4. Idempotência

- A **fonte da verdade** é o header `Idempotency-Key`. A chave (`idempotency_key`) é única no banco.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas) apenas dos **campos de negócio** (provider, id externo, player, wallet, rodada, jogo, tipo, valor normalizado a 2 casas, referência ou `null`). Campos como `Idempotency-Key`, correlation id e ordem das chaves não entram.
- Mesma chave + mesmo hash → **replay**: devolve o resultado guardado (`balance_snapshot` da época, não o saldo atual), HTTP 200, `idempotentReplay: true`, sem efeito novo nem evento novo.
- Mesma chave + hash diferente → `409 IDEMPOTENCY_CONFLICT`.
- Chave diferente mas mesmo `(providerId, externalTransactionId)` → também **409** (`unique(provider_id, external_transaction_id)`): o mesmo id do provedor nunca vira duas transações.
- Em fila há uma segunda camada: o **inbox** `(consumerName, messageId)` descarta a mesma mensagem entregue duas vezes. Outro `messageId` com a mesma chave também não duplica (cai na idempotência acima).

## 5. Ledger e wallet

- `wallets.version` começa em 1 e só sobe quando o **saldo muda** (LOSS não sobe).
- Cada lançamento guarda `wallet_version`, `balance_before`, `balance_after`, direção e a transação de origem. Isso dá a ordem do ledger, o cursor opaco da paginação e a ordenação dos eventos (`walletVersion`).
- O saldo materializado é conferido contra o ledger por `POST /wallets/:id/reconciliation` (soma dos lançamentos × saldo). **Divergência não é corrigida em silêncio**: vira log de erro, incrementa `wallet_reconciliation_divergence_total` e volta `consistent: false` na resposta.
- Todo teste de integração termina com a invariante `wallet.balance == saldo reconstruído pelo ledger`.

## 6. Máquina de estados da `WagerTransaction`

```
              ┌───────────────> PROCESSED   (terminal)
 PENDING ─────┼───────────────> REJECTED    (terminal, com failureCode)
              ├───────────────> FAILED      (terminal, erro inesperado registrado)
              └─> PENDING_REFERENCE ──┬──> PROCESSED
                  (REFUND/ROLLBACK    └──> REJECTED / REFERENCE_NOT_FOUND
                   sem referência)         (esgotou tentativas ou TTL)
```

Estados terminais são imutáveis: no domínio (métodos lançam `InvalidTransactionStateError`) **e** no banco (trigger, ver §10). Transições não listadas são inválidas.

## 7. Reversões (P3)

Regras: REFUND/ROLLBACK exigem `referenceExternalTransactionId`; a referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo player, wallet, moeda e rodada; REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND; o valor tem de ser **igual** ao da referência (parcial fora de escopo).

- **Referência ausente** → `202 PENDING_REFERENCE`, sem efeito financeiro, evento `WagerTransactionPendingReference`. O worker reprocessa com **backoff exponencial**: `base * 2^tentativas`, limitado a `maxDelay`.
- **Limites (defaults):** base 2s, teto 5 min, **10 tentativas ou TTL de 1h**, o que vier primeiro. Soma ≈ 20 min de espera ativa; o TTL cobre o caso de o worker ficar parado. Justificativa: entrega fora de ordem normalmente se resolve em segundos; esperar mais que isso costuma indicar que a referência nunca virá, e uma transação pendente para sempre não ajuda ninguém. Nos testes os valores são reduzidos (100 ms / 4 tentativas).
- **Esgotou** → `REJECTED / REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- **Reversão que deixaria saldo negativo** → `REJECTED / REVERSAL_WOULD_OVERDRAW`, código **diferente** de `INSUFFICIENT_FUNDS` (BET sem saldo), para ficar auditável.
- O worker usa `FOR UPDATE SKIP LOCKED` na transação pendente e depois trava a wallet, igual ao fluxo normal. Vários workers/instâncias não aplicam a reversão duas vezes (testado).

### Interpretações adicionais
- **Uma reversão por referência, de qualquer tipo.** O enunciado fala em "o mesmo tipo de operação"; implementei de forma mais estrita: índice único parcial `uq_wager_tx_single_reversal(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK')`. Assim uma BET não vira REFUND *e* ROLLBACK (duplo estorno). Um ROLLBACK de um REFUND continua permitido, pois referencia o REFUND, não a BET. Se o avaliador esperar o comportamento literal, basta incluir `kind` no índice.
- **Sem FK em `wager_transactions.wallet_id`.** Assim `REJECTED / WALLET_NOT_FOUND` pode ser persistido e reproduzido por idempotência. O ledger e a wallet têm FKs normais.
- **Fila extra `wager-events.fifo`** para eventos de integração (publicados pela outbox). As filas pedidas (`wager-transactions.fifo` e a DLQ) existem como especificado.
- **Ordem dos eventos:** o SQS FIFO usa `MessageGroupId = walletId`, o que ordena por wallet. Consumidores que precisem de ordem devem usar `walletVersion`.
- `eventId` é o `MessageDeduplicationId` do evento e também o id da linha da outbox. `messageId` (fila de entrada) não é a Idempotency-Key: ele deduplica a *entrega*; a chave deduplica a *operação*.

## 8. Taxonomia de `failureCode`

Todo `REJECTED` tem um código. A coluna "Ação" diz ao provedor o que fazer.

| Código | Quando | Ação |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir (ou nova transação após depósito) |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo | desistir; requer intervenção operacional |
| `CURRENCY_MISMATCH` | moeda ≠ da wallet/referência | corrigir |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir |
| `WALLET_PLAYER_MISMATCH` | player não é o dono | corrigir |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo | desistir (ou reenviar referência e reversão) |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada/falhou | desistir |
| `REFERENCE_MISMATCH` | outro player, wallet ou rodada | corrigir |
| `REFERENCE_ALREADY_REVERSED` | já houve reversão | desistir |
| `AMOUNT_MISMATCH` | valor ≠ referência | corrigir |
| `INVALID_REFERENCE_KIND` | tipo de referência não aceito | corrigir |
| `IDEMPOTENCY_CONFLICT` | mesma chave, payload diferente (409) | corrigir |
| `INVALID_PAYLOAD` | payload malformado (400) | corrigir |

Regra de negócio **não é erro**: vira `REJECTED` persistido, 422 no HTTP e ack na fila (reenviar não mudaria nada). Erro **transitório** (Postgres/SQS) vira 503 / retry com backoff. Erro **permanente** de mensagem (JSON inválido, envelope errado) vai para a DLQ.

## 9. Mapeamento HTTP

Uma tabela única, no `AllExceptionsFilter` e nos controllers, para todos os endpoints:

| Status | Quando |
|---|---|
| 201 | transação processada pela primeira vez; wallet criada |
| 200 | replay idempotente; consultas |
| 202 | `PENDING_REFERENCE` (aceito, processamento pendente) |
| 400 | payload inválido, header ausente |
| 404 | recurso inexistente |
| 409 | conflito de idempotência; wallet já existe |
| 422 | rejeição de regra de negócio (corpo traz `failureCode`) |
| 503 | falha transitória de Postgres/SQS, com `Retry-After`; retry com a mesma chave é seguro |
| 500 | bug |

## 10. Schema: o que cada constraint garante

| Constraint / índice | Garante |
|---|---|
| `wallets.balance >= 0` (CHECK) | saldo nunca negativo, mesmo que a aplicação erre |
| `wallets.version` + `UPDATE ... WHERE version` | detecção de escrita concorrente |
| `unique(wallet_id, wallet_version)` (ledger) | um só lançamento por versão; ordem total do ledger |
| trigger no ledger | **append-only**: sem UPDATE/DELETE |
| trigger em `wager_transactions` | estados terminais imutáveis; sem DELETE |
| `uq_wager_tx_idempotency_key` | idempotência persistente |
| `uq_wager_tx_provider_external` | mesmo id do provedor ≠ duas transações |
| `uq_wager_tx_single_reversal` (parcial) | uma reversão por referência |
| CHECKs (`amount > 0`, `kind`, `status`, reversão exige referência, rejeitada exige código) | estados e dados válidos |
| `ix_wager_tx_pending_reference_due` (parcial) | worker acha pendentes sem varrer a tabela |
| `outbox_messages` parcial por `published_at is null` | publisher lê só o que falta |
| `unique(consumer_name, message_id)` (inbox) | mensagem processada uma só vez por consumidor |

Migrations geradas pela CLI do MikroORM (com `up` e `down`); a segunda contém os triggers. `test/integration/migrations.spec.ts` roda `up → down → up` e **falha se o schema real divergir das entidades** (já pegou um `length` sobrando em colunas de timestamp).

## 11. Mensageria

- **Entrada:** `wager-transactions.fifo` + DLQ `wager-transactions-dlq.fifo` com `RedrivePolicy`. Mensagem `{ messageId, type: "WagerTransactionRequested", occurredAt, data: {...campos + idempotencyKey} }`. O `providerId` da mensagem passa pelas mesmas validações do HTTP.
- **Consumidor:** inbox → caso de uso → **ack só depois do commit**. Negócio → ack. Transitório → volta com backoff (visibilidade crescente). Permanente ou tentativas esgotadas → o próprio consumidor move para a DLQ (e a `RedrivePolicy` cobre o resto). Em `stop()`, termina a mensagem em andamento e devolve as demais com visibilidade 0.
- **Cenário crash entre commit e ack:** a fila reentrega; o inbox/idempotência impedem o segundo débito (testado).
- **Workers com backoff em erro (achado em teste manual):** com a fila inexistente, o `BackgroundLoop` do consumidor repetia o `tick` a cada ~60 ms e gerava centenas de logs de erro por segundo. Correção: em erros consecutivos o atraso começa no intervalo normal e **dobra até 30 s**; o primeiro sucesso volta ao intervalo normal. O log acontece **ao entrar em falha** (com `nextDelayMs`) e **ao se recuperar** (com o número de falhas), não a cada tentativa. Coberto por `src/workers/background-loop.spec.ts`.
- **Subida do ambiente (achado em teste manual):** rodar `docker compose up -d` e `bun run queues:create` em sequência rápida falhava com `socket hang up`, porque o MiniStack ainda iniciava. Correção: `healthcheck` no Postgres (`pg_isready`) e no MiniStack, `docker compose up -d --wait` no README, e `queues:create` espera o SQS responder (retry com backoff, ~30 s, erro claro ao esgotar), em `waitForSqs` (`src/messaging/sqs.service.ts`).
- **Saída:** a outbox é lida com `FOR UPDATE SKIP LOCKED`; vários publishers não pegam a mesma linha. Falha ao publicar → `attempts + 1` e `next_attempt_at` com backoff. Se o processo morre depois de enviar e antes de marcar como publicado, outro publica de novo: **at-least-once**, e `eventId` permite ao consumidor ignorar a duplicata.
- **Eventos:** `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` (somente se o saldo mudou). Subclasses de `IntegrationEvent<T>` com `eventType` e `version` fixos; `data` carrega `MoneyProps` (strings).

## 12. Observabilidade

- Logs **JSON** com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem valores monetários completos nem payload inteiro.
- `/metrics` (Prometheus): transações por tipo/status, duplicatas detectadas, retries, mensagens na DLQ, latência de processamento, espera de lock da wallet, `outbox_lag_seconds`, divergências de reconciliação.
- `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres e SQS acessíveis), ambos abertos.

## 13. Autenticação

**Decisão: não implementada** (prazo; o desafio permite). O que eu faria:

- IdP externo (Keycloak ou Zitadel) via OIDC; **nunca** tabela própria de usuários/hash de senha.
- Cada provedor recebe credenciais *client credentials*; a API valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e compara a claim de provedor com o `providerId` do corpo, para um provedor não agir em nome de outro.
- `/health/*` e `/metrics` seguem abertos (ou restritos à rede interna).
- Mensagens da fila são canal interno confiável, mas o `providerId` da mensagem continua passando pelas validações de domínio.

**Ponto de extensão no código:** `src/http/auth.guard.ts`, um `AuthGuard` no-op registrado como `APP_GUARD` em `src/app.module.ts`. Trocar o corpo dele (e marcar rotas públicas com um decorator) é a única mudança necessária.

## 14. Trade-offs e limitações conhecidas

- **SIGTERM no Windows** não executa handlers; o desligamento gracioso é testado em processo (`consumer.stop()`). Em Linux o `enableShutdownHooks` do Nest cuida.
- **Contadores de profundidade de fila** do SQS são aproximados; os testes esperam por estado do banco, não por contadores.
- **Dois sistemas, sem transação distribuída:** a consistência vem de outbox + inbox + idempotência (entrega at-least-once, efeito exactly-once).
- **Sem particionamento nem arquivamento** da outbox/inbox: linhas publicadas ficam na tabela. Em produção: job de limpeza e particionamento por data.
- **Um lock por wallet** limita o throughput de uma única wallet "quente" (cada operação nela é serial). Wallets diferentes escalam em paralelo. Para ordens de grandeza maiores: sharding de wallets ou ledger append-only com saldo por agregação.
- **Teste de carga (`test:load`) não foi feito.** Item opcional; sem medições eu não afirmo números de throughput.
- **OpenTelemetry/dashboards** (opcional) não implementados; há métricas Prometheus e logs JSON.
- **Autenticação** não implementada (§13).
- **Reversão parcial** fora de escopo (`AMOUNT_MISMATCH`).

## 15. Uso de IA e validação

O código foi escrito com apoio do Claude Code (modelo Claude Sonnet 5.5), seguindo as regras do desafio, em etapas (P1, P2, P3) com testes e commit a cada etapa. A validação não depende da IA: tudo roda contra Postgres e SQS reais (`bun run test`), incluindo concorrência, multi-processo e `kill -9`. Fiz um **teste de mutação manual** (removendo o lock da wallet) e um teste que falha com o bug de `getConnection().execute`; ambos revelaram comportamentos que estão documentados acima. As decisões e os trade-offs deste documento são explicáveis sem consultar a ferramenta.

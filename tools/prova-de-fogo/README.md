# Prova de Fogo (teste manual adversarial)

Painel para tentar quebrar o serviço de propósito, além da suíte automatizada.
Cada ataque mostra: o risco, cada requisição enviada, o estado final do banco
(saldo, versão, extrato, reconciliação) e qual defesa do código segurou o ataque.

Foi com ele que encontrei três problemas que os testes automatizados não pegavam
(setup em sequência rápida, workers sem backoff e banco caindo de verdade devolvendo
500 em vez de 503), registrados no ARCHITECTURE.md.

## Como usar

Com a API rodando (`bun run start`), em outro terminal, na raiz do projeto:

```bash
bun run fogo
```

Abra http://localhost:4000.

- **Ataques de aplicação**: só chamam a API. "rodar todos" executa a lista inteira.
- **Ataques de infraestrutura**: param/sobem o Postgres e publicam mensagens na fila via
  `docker compose` (ações fixas, nada vindo do navegador vira comando). Rode um por vez.

Variáveis opcionais: `API_URL` (padrão `http://localhost:3000`), `PANEL_PORT` (padrão `4000`),
`COMPOSE_DIR` (padrão: raiz do projeto).

O servidor do painel escuta só em `127.0.0.1` e repassa `/api/*` para a API (evita CORS).

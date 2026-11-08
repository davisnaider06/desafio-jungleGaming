import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';

export type ProxyMode =
  /** Repassa os bytes para o Postgres de verdade. */
  | 'forward'
  /** Aceita a conexão e a derruba na hora (banco reiniciando / sessão encerrada pelo servidor). */
  | 'drop'
  /**
   * Aceita a conexão e a FECHA de forma limpa (FIN, sem RST). É o que o encaminhador de portas
   * do Docker faz com o Postgres parado: o `pg` reporta "Connection terminated unexpectedly",
   * um `Error` sem `code`.
   */
  | 'close'
  /** Não escuta mais (banco parado: conexão recusada). */
  | 'refuse';

/**
 * Proxy TCP entre a aplicação e o Postgres. Serve para derrubar o banco DE VERDADE, sem mock
 * de erro nenhum: o driver (`pg`) recebe sockets destruídos ou conexão recusada e lança o que
 * lançaria com o Postgres parado. Não depende do Docker CLI.
 */
export class TcpProxy {
  mode: ProxyMode = 'forward';
  /** Conexões que a aplicação tentou abrir enquanto o modo era `drop` ou `close`. */
  droppedConnections = 0;
  port: number;

  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly target: { host: string; port: number },
    port = 0,
  ) {
    this.port = port;
  }

  async start(): Promise<void> {
    this.mode = 'forward';
    await this.listen();
  }

  /** Muda o modo. Fora de `forward`, as conexões que já existem também morrem. */
  async setMode(mode: ProxyMode): Promise<void> {
    this.mode = mode;
    if (mode === 'forward') {
      if (!this.server) await this.listen();
      return;
    }
    this.destroyAll();
    if (mode === 'refuse') await this.closeServer();
    else if (!this.server) await this.listen();
  }

  async stop(): Promise<void> {
    this.destroyAll();
    await this.closeServer();
  }

  private destroyAll(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((client) => this.onClient(client));
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        this.server = server;
        resolve();
      });
    });
  }

  private onClient(client: Socket): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());

    if (this.mode !== 'forward') {
      this.droppedConnections += 1;
      if (this.mode === 'close') client.end();
      else client.destroy();
      return;
    }
    const upstream = createConnection(this.target);
    this.sockets.add(upstream);
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  }
}

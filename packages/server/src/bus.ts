import type { ServerResponse } from 'node:http';

/**
 * SSE の配信。Claude が MCP 経由で訳を書き込んだ瞬間にブラウザが更新されるのは
 * このツールの体験の中心なので、更新通知はポーリングではなく push にしてある。
 */

export type ServerEvent =
  | { type: 'document.created'; documentId: string }
  | { type: 'document.updated'; documentId: string; reason: string }
  | { type: 'document.deleted'; documentId: string }
  | { type: 'translation.updated'; documentId: string; sentenceHash: string }
  | { type: 'note.changed'; documentId: string; sentenceHash: string | null };

export class EventBus {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    // プロキシや OS のアイドル切断対策。15 秒ごとにコメント行を送る。
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(': keepalive\n\n');
    }, 15_000);
    this.heartbeat.unref();
  }

  subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 2000\n\n');
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  publish(event: ServerEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}

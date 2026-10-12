import type { ServerResponse } from 'node:http';

/**
 * SSE の配信。Claude が MCP 経由で訳を書き込んだ瞬間にブラウザが更新されるのは
 * このツールの体験の中心なので、更新通知はポーリングではなく push にしてある。
 *
 * 購読者が読まない場合に備えて背圧を見る。以前は write() の戻り値を捨てていたため、
 * TCP を読まない購読者が 1 つあるだけで全イベントが内部バッファに無限に積まれ、
 * ローカルの任意のページが /api/events を開いて放置するだけで OOM にできた。
 *
 * 取りこぼしても壊れない設計にしてあるのが効いている（クライアントは retry で
 * 再接続し、文書全体を取り直す）。だから詰まった購読者は落として構わない。
 */

export type ServerEvent =
  | { type: 'document.created'; documentId: string }
  | { type: 'document.updated'; documentId: string; reason: string }
  | { type: 'document.deleted'; documentId: string }
  | { type: 'translation.updated'; documentId: string; sentenceHash: string }
  | { type: 'note.changed'; documentId: string; sentenceHash: string | null };

/** 1 購読者あたりの未送信バイト数の上限。超えたら切る。 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** 同時購読者数の上限。ローカル用途では十分に多い。 */
const MAX_CLIENTS = 64;

export class EventBus {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    // プロキシや OS のアイドル切断対策。15 秒ごとにコメント行を送る。
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.send(client, ': keepalive\n\n');
    }, 15_000);
    this.heartbeat.unref();
  }

  /** 購読を受け付ける。上限を超えていたら 503 を返して断る。 */
  subscribe(response: ServerResponse): boolean {
    if (this.clients.size >= MAX_CLIENTS) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'SSE の購読数が上限に達しています' }));
      return false;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    response.write('retry: 2000\n\n');
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
    response.on('error', () => this.drop(response));
    return true;
  }

  private drop(response: ServerResponse): void {
    this.clients.delete(response);
    response.end();
  }

  private send(response: ServerResponse, payload: string): void {
    if (response.writableEnded || response.destroyed) {
      this.clients.delete(response);
      return;
    }
    if (response.writableLength > MAX_BUFFERED_BYTES) {
      // 読んでいない購読者。ここで切らないとバッファが無限に伸びる。
      this.drop(response);
      return;
    }
    response.write(payload);
  }

  publish(event: ServerEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...this.clients]) this.send(client, payload);
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

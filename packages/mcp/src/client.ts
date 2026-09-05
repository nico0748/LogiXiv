import type { PaperDocument } from '@logixiv/core';

/**
 * MCP サーバーは LogiXiv 本体のプロセスに HTTP で話しかける。
 *
 * ファイルを直接触らないのは、書き手を 1 プロセスに絞るため。
 * こうしておくと排他制御が 1 箇所で済み、Claude が書いた訳がそのまま SSE で
 * 開いているブラウザに流れる（MCP から直接ファイルを書くと画面が更新されない）。
 */

export class LogiXivNotRunningError extends Error {
  constructor(baseUrl: string, cause: string) {
    super(
      `LogiXiv 本体 (${baseUrl}) に接続できません: ${cause}\n` +
        '別のターミナルで `npx logixiv` を実行してから、もう一度試してください。',
    );
  }
}

export interface DocumentSummary {
  id: string;
  title: string;
  updatedAt: string;
  parser: string;
  total: number;
  translated: number;
}

export class LogiXivClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new LogiXivNotRunningError(this.baseUrl, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // JSON でなければ本文をそのまま見せる。
      }
      throw new Error(message);
    }
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  }

  health() {
    return this.request<{ ok: true; version: string; grobid: 'up' | 'down'; grobidUrl: string; dataDir: string }>(
      '/api/health',
    );
  }

  listDocuments() {
    return this.request<{ documents: DocumentSummary[] }>('/api/documents');
  }

  getDocument(id: string) {
    return this.request<PaperDocument>(`/api/documents/${encodeURIComponent(id)}`);
  }

  untranslated(id: string, limit: number) {
    return this.request<{ sentences: { sentenceHash: string; order: number; page: number; text: string }[] }>(
      `/api/documents/${encodeURIComponent(id)}/untranslated?limit=${limit}`,
    );
  }

  search(id: string, query: string) {
    return this.request<{
      hits: { sentenceId: string; sentenceHash: string; page: number; text: string; where: string[] }[];
    }>(`/api/documents/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`);
  }

  setTranslations(id: string, entries: { sentenceHash: string; text: string }[]) {
    return this.request<{ applied: number; skipped: { sentenceHash: string; reason: string }[] }>(
      `/api/documents/${encodeURIComponent(id)}/translations`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, source: 'claude' }),
      },
    );
  }

  addNote(id: string, sentenceHash: string, body: string, author: string | null) {
    return this.request<{ id: string }>(`/api/documents/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentenceHash, body, author }),
    });
  }

  setGlossary(id: string, entries: { term: string; translation: string; note?: string }[]) {
    return this.request<{ ok: true }>(`/api/documents/${encodeURIComponent(id)}/glossary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
  }

  reparse(id: string, parser: 'auto' | 'grobid' | 'fallback') {
    return this.request<{ rebound: number; orphaned: number; warning: string | null }>(
      `/api/documents/${encodeURIComponent(id)}/reparse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parser }),
      },
    );
  }
}

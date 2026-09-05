/**
 * ローカル API の薄いラッパ。
 * 相対パスにしているのは、UI が必ず同じオリジンのサーバーから配られるため
 * （外部ホストを指す設定を作らない、というのがこのツールの前提）。
 */

export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sentence {
  id: string;
  hash: string;
  order: number;
  page: number;
  text: string;
  rects: Rect[];
  sectionId: string | null;
}

export interface Section {
  id: string;
  title: string;
  level: number;
  order: number;
}

export interface Translation {
  sentenceHash: string;
  text: string;
  revisedByHuman: boolean;
  source: 'claude' | 'human' | 'import';
  updatedAt: string;
}

export interface Note {
  id: string;
  sentenceHash: string;
  body: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperDocument {
  id: string;
  title: string;
  sourceFileName: string;
  createdAt: string;
  updatedAt: string;
  structure: {
    version: 1;
    parser: 'grobid' | 'fallback';
    parserNote: string;
    parsedAt: string;
    title: string | null;
    abstract: string | null;
    pageSizes: { page: number; width: number; height: number }[];
    sections: Section[];
    sentences: Sentence[];
  };
  annotations: {
    translations: Record<string, Translation>;
    notes: Note[];
    glossary: { term: string; translation: string; note: string | null }[];
  };
}

export interface DocumentSummary {
  id: string;
  title: string;
  updatedAt: string;
  parser: string;
  total: number;
  translated: number;
}

export interface Health {
  ok: true;
  version: string;
  grobid: 'up' | 'down';
  grobidUrl: string;
  dataDir: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  health: () => request<Health>('/api/health'),

  listDocuments: () => request<{ documents: DocumentSummary[] }>('/api/documents'),

  getDocument: (id: string) => request<PaperDocument>(`/api/documents/${id}`),

  deleteDocument: (id: string) => request<{ ok: true }>(`/api/documents/${id}`, { method: 'DELETE' }),

  uploadPdf: (file: File) =>
    request<{ documentId: string; usedFallback: boolean; warning: string | null; sentences: number }>(
      '/api/documents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      },
    ),

  setTranslation: (id: string, hash: string, text: string) =>
    request<{ applied: boolean; reason?: string }>(`/api/documents/${id}/translations/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: 'human' }),
    }),

  addNote: (id: string, sentenceHash: string, body: string) =>
    request<{ id: string }>(`/api/documents/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentenceHash, body, author: 'me' }),
    }),

  deleteNote: (id: string, noteId: string) =>
    request<{ applied: boolean }>(`/api/documents/${id}/notes/${noteId}`, { method: 'DELETE' }),

  reparse: (id: string) =>
    request<{ rebound: number; orphaned: number; warning: string | null }>(`/api/documents/${id}/reparse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parser: 'auto' }),
    }),

  importHtml: (id: string, html: string) =>
    request<{ documentId: string; report: unknown; note: string }>(`/api/documents/${id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    }),

  exportUrl: (id: string) => `/api/documents/${id}/export`,
  pdfUrl: (id: string) => `/api/documents/${id}/pdf`,
};

/** SSE。Claude が MCP から書き込んだ訳を、リロード無しで反映するための購読。 */
export function subscribe(onEvent: (event: { type: string; documentId: string }) => void): () => void {
  const source = new EventSource('/api/events');
  const handler = (event: MessageEvent<string>): void => {
    try {
      onEvent(JSON.parse(event.data) as { type: string; documentId: string });
    } catch {
      // 壊れたイベントは無視する。次の更新で追いつく。
    }
  };
  for (const type of ['document.created', 'document.updated', 'document.deleted', 'translation.updated', 'note.changed']) {
    source.addEventListener(type, handler as EventListener);
  }
  return () => source.close();
}

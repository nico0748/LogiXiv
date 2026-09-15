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
    version: number;
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
    /** 訳さないと判断した文（キーは hash）。古い保存データには無い。 */
    skipped?: Record<string, { sentenceHash: string; reason: string; at: string }>;
    /** 人が直した文の区切り。再解析のときに流し直される。 */
    sentenceEdits?: {
      id: string;
      type: 'merge' | 'split';
      hashes: string[];
      offsets?: number[];
      /** いまの構造に当たっていない記録。元の方式に戻せば効き直す。 */
      detached?: boolean;
      createdAt: string;
    }[];
  };
}

export interface SentenceEditResult {
  applied: boolean;
  /** 何か所に適用されたか。 */
  occurrences: number;
  editId?: string;
  /** 編集の結果できた文の hash（画面の選択を追わせるのに使う）。 */
  resultHashes: string[];
  /** どの文にも結び付かなくなった注釈の数。消えてはおらず、取り消せば戻る。 */
  detached: { translations: number; notes: number; skipped: number };
  reason?: string;
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
  /** Claude 用の MCP 設定を画面に出すための情報。 */
  mcp?: {
    entry: string | null;
    url: string;
    /** この OS での Claude Desktop の設定ファイル。貼り先を画面に出すため。 */
    configPath?: string;
    /** 端末で 1 行で済ませたい人向け（Claude Code）。 */
    addCommand?: string | null;
    /** MCP から最後に呼ばれた時刻（epoch ms）。null なら一度もつながっていない。 */
    lastContactAt?: number | null;
  };
}

/**
 * 本体が返したエラー。状態コードを残す。
 *
 * 「断られた」と「壊れた」は呼び出し側のやることが違う。取り込みの一致率で
 * 断られたときは、人に「それでも取り込むか」を訊いて送り直せるが、
 * 素の Error だとその分岐ができず、やり直す道の無い赤い文字になる。
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
    throw new ApiError(response.status, message);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  health: () => request<Health>('/api/health'),

  listDocuments: () => request<{ documents: DocumentSummary[] }>('/api/documents'),

  getDocument: (id: string) => request<PaperDocument>(`/api/documents/${id}`),

  /** 用語集は 1 件ずつ送る。一覧をまるごと送ると、その間に Claude が足した語が消える。 */
  putGlossaryEntry: (id: string, entry: { term: string; translation: string; note: string | null }) =>
    request<{ added: boolean; total: number }>(`/api/documents/${id}/glossary/entry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }),

  deleteGlossaryEntry: (id: string, term: string) =>
    request<{ removed: boolean; total: number }>(
      `/api/documents/${id}/glossary/entry?term=${encodeURIComponent(term)}`,
      { method: 'DELETE' },
    ),

  /** 訳語を変えたときに書き換わる候補を、1 件残らず見る（書き込みはしない）。 */
  previewTermReplacement: (id: string, from: string, to: string) =>
    request<{
      total: number;
      revisedByHuman: number;
      /** 画面に出せた件数と、打ち切りの有無。超えた分は選べないまま置換されない。 */
      shown: number;
      truncated: boolean;
      limit: number;
      candidates: {
        sentenceHash: string;
        before: string;
        after: string;
        revisedByHuman: boolean;
        /** どの文の訳かを突き合わせるための原文と位置。 */
        text: string;
        order: number;
        page: number;
      }[];
    }>(`/api/documents/${id}/glossary/preview-replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    }),

  /** 画面で見せた内容と一致する行だけを書き換える。 */
  applyTranslationEdits: (
    id: string,
    edits: { sentenceHash: string; before: string; after: string }[],
  ) =>
    request<{ applied: number; stale: string[] }>(`/api/documents/${id}/translations/apply-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits }),
    }),

  renameDocument: (id: string, title: string) =>
    request<{ id: string; title: string }>(`/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),

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
    request<{ applied: boolean; id?: string; reason?: string }>(`/api/documents/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentenceHash, body, author: 'me' }),
    }),

  /** 訳を消す。`alsoSkip` を立てると、消したうえで「訳さない」に移す。 */
  deleteTranslation: (id: string, hash: string, alsoSkip = false) =>
    request<{ deleted: boolean; skipped: boolean }>(
      `/api/documents/${id}/translations/${hash}${alsoSkip ? '?skip=1' : ''}`,
      { method: 'DELETE' },
    ),

  skipSentence: (id: string, hash: string, reason = 'other') =>
    request<{ applied: number; remaining: number }>(`/api/documents/${id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [hash], reason }),
    }),

  unskipSentence: (id: string, hash: string) =>
    request<{ applied: number; remaining: number }>(`/api/documents/${id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [hash], undo: true }),
    }),

  deleteNote: (id: string, noteId: string) =>
    request<{ applied: boolean }>(`/api/documents/${id}/notes/${noteId}`, { method: 'DELETE' }),

  /** 連続する文を 1 文に結合する。同じ本文が複数箇所にあれば、そのすべてに効く。 */
  mergeSentences: (id: string, hashes: string[]) =>
    request<SentenceEditResult>(`/api/documents/${id}/sentence-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'merge', hashes }),
    }),

  /** 1 文を文字位置で割る。 */
  splitSentence: (id: string, hash: string, offsets: number[]) =>
    request<SentenceEditResult>(`/api/documents/${id}/sentence-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'split', hashes: [hash], offsets }),
    }),

  undoSentenceEdit: (id: string, editId?: string) =>
    request<{ applied: boolean; reason?: string }>(
      `/api/documents/${id}/sentence-edits${editId ? `?editId=${encodeURIComponent(editId)}` : ''}`,
      { method: 'DELETE' },
    ),

  reparse: (id: string, parser: 'auto' | 'grobid' | 'fallback' = 'auto') =>
    request<{
      rebound: number;
      orphaned: number;
      editsReapplied: number;
      editsDropped: number;
      warning: string | null;
    }>(`/api/documents/${id}/reparse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parser }),
    }),

  /** 他人の書き出しを新しい文書として取り込む（PDF ごと入る）。 */
  importNewDocument: (html: string) =>
    request<{ documentId: string; note: string; warning: string | null }>('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    }),

  /**
   * 他人の書き出しを今の文書へ重ねる。
   *
   * 一致率が低いと本体が 400 で止める（別の論文を落としたときに、
   * 訳語方針だけが静かに混ざるのを防ぐため）。人が「それでも」と言ったときだけ
   * `force` を立てて送り直す。
   */
  importHtml: (id: string, html: string, force = false) =>
    request<{
      documentId: string;
      report: unknown;
      note: string;
      warning: string | null;
      overlap: number | null;
    }>(`/api/documents/${id}/import${force ? '?force=true' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    }),

  exportUrl: (id: string) => `/api/documents/${id}/export`,
  pdfUrl: (id: string) => `/api/documents/${id}/pdf`,
};

/** SSE。Claude が MCP から書き込んだ訳を、リロード無しで反映するための購読。 */
export function subscribe(
  onEvent: (event: { type: string; documentId: string }) => void,
  onReconnect?: () => void,
): () => void {
  const source = new EventSource('/api/events');
  // 接続し直したときに知らせる。これが無いと、サーバーが落ちている間に
  // 失敗した一覧の取得が、サーバーが戻っても永久にエラー表示のまま残る。
  if (onReconnect) source.addEventListener('open', () => onReconnect());
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

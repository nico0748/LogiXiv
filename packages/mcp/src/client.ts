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
        'リポジトリのディレクトリで `npm start` を実行して本体を起動してから、もう一度試してください。\n' +
        '別のポートで動かしている場合は、MCP の設定で環境変数 LOGIXIV_URL をそのアドレスに合わせてください。',
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
  remaining: number;
}

export interface SkippedWrite {
  sentenceHash: string;
  reason: string;
  code: 'revised_by_human' | 'unknown_hash' | 'other';
}

export interface SearchHit {
  sentenceId: string;
  sentenceHash: string;
  /** 本文の通し番号。本文として扱わなかった行には無いので null。 */
  order: number | null;
  page: number;
  text: string;
  translation: string | null;
  notes: string[];
  where: string[];
  /** 訳の対象になる本文か。false は参考文献・キャプション・脚注など。 */
  isBody: boolean;
  /** 本文でないときだけ、その種類。 */
  nonBodyKind: string | null;
  /** 本文でないときだけ、直前に来る本文の通し番号（本文より前なら -1）。 */
  afterOrder: number | null;
}

export interface SentenceView {
  sentenceHash: string;
  order: number;
  page: number;
  text: string;
  translation: string | null;
  revisedByHuman: boolean;
  notes: string[];
}

/**
 * 本文が空の失敗応答を、それでも意味のある日本語にする。
 *
 * 状態番号しか手掛かりが無い場面なので、番号の意味と「次に何ができるか」を書く。
 * 「HTTP 431」とだけ返すのは、空文字を返すのとほとんど変わらない。
 */
function describeEmptyFailure(status: number, path: string): string {
  if (status === 431) {
    return (
      `LogiXiv 本体が ${status}（リクエストが大きすぎる）を本文なしで返しました。` +
      'URL に載せた値が Node の既定ヘッダ上限（16KB）を越えています。' +
      '検索語のような長い値は本文で渡すか、短くしてから渡し直してください。' +
      `（要求: ${path.slice(0, 120)}）`
    );
  }
  if (status === 413) {
    return `LogiXiv 本体が ${status}（本文が大きすぎる）を本文なしで返しました。渡す量を減らしてください。`;
  }
  return (
    `LogiXiv 本体が HTTP ${status} を本文なしで返しました（理由の説明が付いていません）。` +
    `本体のログに手掛かりが出ているはずです。（要求: ${path.slice(0, 120)}）`
  );
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
        headers: {
          Accept: 'application/json',
          // 本体に「MCP から来た」と分かるようにする。画面側で
          // 「設定が効いているのか分からない」を解くために要る。
          'X-LogiXiv-Client': 'mcp',
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new LogiXivNotRunningError(this.baseUrl, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 400).trim();
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // JSON でなければ本文をそのまま見せる。
      }
      // **本文が空でも、必ず理由の分かる 1 文にする。**
      // 本体に届く前に Node が撥ねた応答（431 など）には本文が無く、
      // これをそのまま投げていたので Error('') になり、MCP の
      // `content[0].text` が空文字のまま Claude に返っていた。
      // 何が悪かったのか一文字も届かないので、同じ呼び出しが延々と繰り返される。
      if (message.length === 0) message = describeEmptyFailure(response.status, path);
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

  /**
   * 検索語は**本文**で送る。
   *
   * クエリ文字列に載せていたときは、17KB 付近から Node の既定ヘッダ上限に当たり、
   * 本体のコードに一度も届かないまま 431 が本文なしで返っていた。
   * 段落まるごとを検索語にする使い方では普通に起きる長さなので、経路ごと変える。
   */
  search(id: string, query: string, limit = 30, from = 0) {
    return this.request<{ total: number; truncated: boolean; hits: SearchHit[] }>(
      `/api/documents/${encodeURIComponent(id)}/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, limit, from }),
      },
    );
  }

  skipSentences(id: string, hashes: string[], reason: string) {
    return this.request<{ applied: number; unknown: string[]; alreadyTranslated: string[]; remaining: number }>(
      `/api/documents/${encodeURIComponent(id)}/skip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes, reason }),
      },
    );
  }

  unskipSentences(id: string, hashes: string[]) {
    return this.request<{ applied: number; remaining: number }>(
      `/api/documents/${encodeURIComponent(id)}/skip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes, undo: true }),
      },
    );
  }

  sentencesByHash(id: string, hashes: string[]) {
    return this.request<{ sentences: SentenceView[] }>(`/api/documents/${encodeURIComponent(id)}/sentences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
  }

  setTranslations(id: string, entries: { sentenceHash: string; text: string }[]) {
    return this.request<{
      applied: number;
      created: number;
      overwritten: number;
      sentencesAffected: number;
      duplicates: string[];
      skipped: SkippedWrite[];
    }>(
      `/api/documents/${encodeURIComponent(id)}/translations`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, source: 'claude' }),
      },
    );
  }

  addNote(id: string, sentenceHash: string, body: string, author: string | null) {
    return this.request<{ applied: boolean; id?: string; reason?: string }>(
      `/api/documents/${encodeURIComponent(id)}/notes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentenceHash, body, author }),
      },
    );
  }

  /** 追記。既存の用語集を消さない。 */
  addGlossaryEntries(id: string, entries: { term: string; translation: string; note?: string | null }[]) {
    return this.request<{ added: number; updated: number; total: number }>(`/api/documents/${encodeURIComponent(id)}/glossary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
  }

  replaceGlossary(id: string, entries: { term: string; translation: string; note?: string | null }[]) {
    return this.request<{ ok: true; total: number }>(`/api/documents/${encodeURIComponent(id)}/glossary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
  }

  editSentenceBoundary(id: string, input: { type: 'merge' | 'split' | 'drop'; hashes: string[]; offsets?: number[] }) {
    return this.request<{
      applied: boolean;
      occurrences: number;
      editId?: string;
      resultHashes: string[];
      detached: { translations: number; notes: number; skipped: number };
      reason?: string;
    }>(
      `/api/documents/${encodeURIComponent(id)}/sentence-edits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  }

  undoSentenceEdit(id: string, editId?: string) {
    return this.request<{ applied: boolean; reason?: string }>(
      `/api/documents/${encodeURIComponent(id)}/sentence-edits${
        editId ? `?editId=${encodeURIComponent(editId)}` : ''
      }`,
      { method: 'DELETE' },
    );
  }

  reparse(id: string, parser: 'auto' | 'grobid' | 'fallback') {
    return this.request<{
      document: PaperDocument;
      rebound: number;
      orphaned: number;
      editsReapplied: number;
      editsDropped: number;
      warning: string | null;
    }>(
      `/api/documents/${encodeURIComponent(id)}/reparse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parser }),
      },
    );
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe, type PaperDocument, type Sentence } from './api.ts';
import { PdfPane } from './PdfPane.tsx';
import { Sidebar } from './Sidebar.tsx';

interface Props {
  documentId: string;
  onBack: () => void;
}

/**
 * SSE の合体待ち時間。
 *
 * Claude が MCP で連続翻訳すると 1 文ごとにイベントが飛ぶ。イベント 1 件ごとに
 * 文書全体（全文＋全訳＋全座標）を取り直していた頃は、リーダーを開いているだけで
 * 100 文の書き込みが 3.3 秒 → 20.6 秒に伸びていた。取りこぼしても次の合体で
 * 最新に追いつくので、まとめて 1 回にする。
 */
const RELOAD_DEBOUNCE_MS = 300;

export function Reader({ documentId, onBack }: Props): React.JSX.Element {
  const [paper, setPaper] = useState<PaperDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  /** どちら側から選んだか。選んだ側はスクロールさせない。 */
  const [pdfScrollTarget, setPdfScrollTarget] = useState<{ id: string; token: number } | null>(null);
  const [sidebarScrollTarget, setSidebarScrollTarget] = useState<{ id: string; token: number } | null>(null);
  const selectionToken = useRef(0);

  const select = useCallback((id: string, origin: 'pdf' | 'sidebar') => {
    setSelectedId(id);
    selectionToken.current += 1;
    const token = selectionToken.current;
    if (origin === 'pdf') setSidebarScrollTarget({ id, token });
    else setPdfScrollTarget({ id, token });
  }, []);

  const reload = useCallback(async () => {
    try {
      setPaper(await api.getDocument(documentId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // MCP 経由で Claude が書いた訳を、リロードせずに反映する。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event) => {
      if (event.documentId !== documentId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [documentId, reload]);

  const notesByHash = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!paper) return map;
    for (const note of paper.annotations.notes) {
      const list = map.get(note.sentenceHash);
      if (list) list.push(note.body);
      else map.set(note.sentenceHash, [note.body]);
    }
    return map;
  }, [paper]);

  const visibleSentences: Sentence[] = useMemo(() => {
    if (!paper) return [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return paper.structure.sentences;
    return paper.structure.sentences.filter((sentence) => {
      const haystack = [
        sentence.text,
        paper.annotations.translations[sentence.hash]?.text ?? '',
        ...(notesByHash.get(sentence.hash) ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [paper, filter, notesByHash]);

  const visibleIds = useMemo(
    () => (filter.trim().length === 0 ? null : new Set(visibleSentences.map((s) => s.id))),
    [filter, visibleSentences],
  );

  const stats = useMemo(() => {
    if (!paper) return null;
    // 訳は「異なり文」単位で付く。文の総数を分母にすると 100% にならない。
    const hashes = new Set(paper.structure.sentences.map((s) => s.hash));
    const skipped = paper.annotations.skipped ?? {};
    let translated = 0;
    let skippedCount = 0;
    for (const hash of hashes) {
      if (paper.annotations.translations[hash]) translated++;
      else if (skipped[hash]) skippedCount++;
    }
    return { total: hashes.size, translated, skipped: skippedCount };
  }, [paper]);

  if (error && !paper) {
    return (
      <div className="pane-message">
        {error}{' '}
        <button type="button" onClick={onBack}>
          一覧へ戻る
        </button>
      </div>
    );
  }
  if (!paper || !stats) return <div className="pane-message">読み込んでいます…</div>;

  /** 失敗を黙って捨てないための共通ラッパ。以前は保存に失敗しても画面が無反応だった。 */
  const run = async (label: string, task: () => Promise<string | null>): Promise<boolean> => {
    setBusyAction(label);
    try {
      const note = await task();
      if (note) setMessage(note);
      return true;
    } catch (cause) {
      setMessage(`${label}に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const saveTranslation = (hash: string, text: string): Promise<boolean> =>
    run('訳の保存', async () => {
      const result = await api.setTranslation(documentId, hash, text);
      await reload();
      if (!result.applied) throw new Error(result.reason ?? '保存されませんでした');
      return null;
    });

  const runImport = (file: File): Promise<boolean> =>
    run('取り込み', async () => {
      const html = await file.text();
      const result = await api.importHtml(documentId, html);
      await reload();
      const report = result.report as Record<string, number> | null;
      const base = report
        ? `取り込み完了: 訳 +${report['translationsAdded'] ?? 0} / 更新 ${report['translationsUpdated'] ?? 0} / メモ +${report['notesAdded'] ?? 0} / 対応なし ${report['orphaned'] ?? 0}`
        : result.note;
      return result.warning ? `${base}（${result.warning}）` : base;
    });

  return (
    <div className="reader">
      <header className="toolbar">
        <button type="button" onClick={onBack}>
          ← 一覧
        </button>
        <strong className="toolbar-title" title={paper.title}>
          {paper.title}
        </strong>
        <span className={`badge${paper.structure.parser === 'grobid' ? ' is-good' : ' is-warn'}`}>
          {paper.structure.parser === 'grobid' ? 'GROBID 解析' : '簡易解析'}
        </span>
        <span className="toolbar-progress" title="訳は同じ本文ごとに 1 つ付きます">
          {stats.translated} / {stats.total} 文
          {stats.skipped > 0 && `（訳さない ${stats.skipped}）`}
        </span>

        <input
          className="toolbar-search"
          type="search"
          value={filter}
          placeholder="原文・訳文・メモを検索"
          aria-label="文書内検索"
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="toolbar-zoom">
          <button
            type="button"
            aria-label="縮小"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
          >
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="拡大"
            onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.1) * 10) / 10))}
          >
            ＋
          </button>
        </div>

        <a className="button-link" href={api.exportUrl(documentId)} download>
          書き出し
        </a>
        <button type="button" disabled={busyAction !== null} onClick={() => importInput.current?.click()}>
          取り込み
        </button>
        <input
          ref={importInput}
          type="file"
          accept=".html,text/html"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void runImport(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() =>
            void run('再解析', async () => {
              const result = await api.reparse(documentId);
              await reload();
              return `再解析しました（訳の再結合 ${result.rebound} 件 / 対応なし ${result.orphaned} 件）${
                result.warning ? ` — ${result.warning}` : ''
              }`;
            })
          }
        >
          {busyAction === '再解析' ? '再解析中…' : '再解析'}
        </button>
      </header>

      <p className="parser-note">{paper.structure.parserNote}</p>
      {message && (
        <p className="flash" role="status" aria-live="polite">
          {message}
          <button type="button" className="flash-close" aria-label="閉じる" onClick={() => setMessage(null)}>
            ×
          </button>
        </p>
      )}

      <div className="reader-body">
        <PdfPane
          document={paper}
          selectedId={selectedId}
          onSelect={select}
          visibleSentenceIds={visibleIds}
          zoom={zoom}
          scrollTarget={pdfScrollTarget}
        />
        <Sidebar
          document={paper}
          selectedId={selectedId}
          filter={filter}
          visibleSentences={visibleSentences}
          onSelect={select}
          scrollTarget={sidebarScrollTarget}
          onSaveTranslation={saveTranslation}
          onAddNote={(hash, body) =>
            run('メモの追加', async () => {
              await api.addNote(documentId, hash, body);
              await reload();
              return null;
            })
          }
          onDeleteNote={(noteId) =>
            run('メモの削除', async () => {
              await api.deleteNote(documentId, noteId);
              await reload();
              return null;
            })
          }
          onToggleSkip={(hash, skip) =>
            run(skip ? '訳さない設定' : '訳す対象への復帰', async () => {
              if (skip) await api.skipSentence(documentId, hash);
              else await api.unskipSentence(documentId, hash);
              await reload();
              return null;
            })
          }
        />
      </div>
    </div>
  );
}

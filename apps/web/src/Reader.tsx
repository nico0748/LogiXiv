import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe, type PaperDocument } from './api.ts';
import { PdfPane } from './PdfPane.tsx';
import { Sidebar } from './Sidebar.tsx';

interface Props {
  documentId: string;
  onBack: () => void;
}

export function Reader({ documentId, onBack }: Props): React.JSX.Element {
  const [paper, setPaper] = useState<PaperDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setPaper(await api.getDocument(documentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // MCP 経由で Claude が書いた訳を、リロードせずに反映する。
  useEffect(() => {
    return subscribe((event) => {
      if (event.documentId === documentId) void reload();
    });
  }, [documentId, reload]);

  const stats = useMemo(() => {
    if (!paper) return null;
    const total = paper.structure.sentences.length;
    const translated = paper.structure.sentences.filter((s) => paper.annotations.translations[s.hash]).length;
    return { total, translated };
  }, [paper]);

  if (error) {
    return (
      <div className="pane-message">
        {error} <button type="button" onClick={onBack}>一覧へ戻る</button>
      </div>
    );
  }
  if (!paper || !stats) return <div className="pane-message">読み込んでいます…</div>;

  const saveTranslation = async (hash: string, text: string): Promise<void> => {
    const result = await api.setTranslation(documentId, hash, text);
    if (!result.applied) setMessage(result.reason ?? '保存できませんでした');
    await reload();
  };

  const runImport = async (file: File): Promise<void> => {
    try {
      const html = await file.text();
      const result = await api.importHtml(documentId, html);
      const report = result.report as Record<string, number> | null;
      setMessage(
        report
          ? `取り込み完了: 訳 +${report['translationsAdded'] ?? 0} / 更新 ${report['translationsUpdated'] ?? 0} / メモ +${report['notesAdded'] ?? 0} / 対応なし ${report['orphaned'] ?? 0}`
          : result.note,
      );
      await reload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
        <span className="toolbar-progress">
          {stats.translated} / {stats.total} 文
        </span>

        <input
          className="toolbar-search"
          type="search"
          value={filter}
          placeholder="原文・訳文・メモを検索"
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="toolbar-zoom">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.1) * 10) / 10))}>
            ＋
          </button>
        </div>

        <a className="button-link" href={api.exportUrl(documentId)} download>
          書き出し
        </a>
        <button type="button" onClick={() => importInput.current?.click()}>
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
          onClick={() => {
            void api.reparse(documentId).then((result) => {
              setMessage(
                `再解析しました（訳の再結合 ${result.rebound} 件 / 対応なし ${result.orphaned} 件）${result.warning ? ` — ${result.warning}` : ''}`,
              );
              void reload();
            });
          }}
        >
          再解析
        </button>
      </header>

      <p className="parser-note">{paper.structure.parserNote}</p>
      {message && (
        <p className="flash" onClick={() => setMessage(null)}>
          {message}
        </p>
      )}

      <div className="reader-body">
        <PdfPane document={paper} selectedId={selectedId} onSelect={setSelectedId} zoom={zoom} />
        <Sidebar
          document={paper}
          selectedId={selectedId}
          filter={filter}
          onSelect={setSelectedId}
          onSaveTranslation={saveTranslation}
          onAddNote={async (hash, body) => {
            await api.addNote(documentId, hash, body);
            await reload();
          }}
          onDeleteNote={async (noteId) => {
            await api.deleteNote(documentId, noteId);
            await reload();
          }}
        />
      </div>
    </div>
  );
}

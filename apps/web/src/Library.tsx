import { useCallback, useEffect, useState } from 'react';
import { api, subscribe, type DocumentSummary, type Health } from './api.ts';

interface Props {
  onOpen: (documentId: string) => void;
}

export function Library({ onOpen }: Props): React.JSX.Element {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    // 失敗を握り潰すと documents が [] のままになり、「まだ論文がありません」と
    // 表示される。手元のデータが消えたようにしか見えないので、必ず理由を出す。
    try {
      const [list, status] = await Promise.all([api.listDocuments(), api.health().catch(() => null)]);
      setDocuments(list.documents);
      setHealth(status);
      setListError(null);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    // SSE が繋がり直したら取り直す。サーバーを起動し直したあと、
    // 画面がエラーのまま取り残されないように。
    return subscribe(
      () => void reload(),
      () => void reload(),
    );
  }, [reload]);

  /**
   * PDF と「LogiXiv の書き出し HTML」の両方を受ける。
   * 後者は他人から送られてくるものなので、1 本も持っていない人でも
   * ここから始められる必要がある。
   */
  const accept = async (file: File): Promise<void> => {
    const isExport = /\.html?$/i.test(file.name) || file.type === 'text/html';
    setBusy(true);
    setMessage(
      isExport
        ? `${file.name} を取り込んでいます…`
        : `${file.name} を解析しています…（GROBID 経由だと数十秒かかることがあります）`,
    );
    try {
      if (isExport) {
        const result = await api.importNewDocument(await file.text());
        setMessage(result.warning ? `取り込みました（${result.warning}）` : '取り込みました。');
        await reload();
        onOpen(result.documentId);
        return;
      }
      const result = await api.uploadPdf(file);
      setMessage(
        result.warning
          ? `${result.warning}（${result.sentences} 文）`
          : `${result.sentences} 文に分割しました。`,
      );
      await reload();
      onOpen(result.documentId);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="library">
      <header className="library-header">
        <h1>LogiXiv</h1>
        <p className="library-sub">論文を 1 文ずつ読むための対訳リーダー</p>
      </header>

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          // 解析中のドロップは無視する。受け付けると並行アップロードが走り、
          // どの文書が開かれるか不定になる。
          if (busy) return;
          const files = event.dataTransfer.files;
          if (files.length === 0) return;
          if (files.length > 1) setMessage(`${files.length} 件のうち 1 件目だけを取り込みます。`);
          void accept(files[0]!);
        }}
      >
        <p>PDF、または LogiXiv の書き出し HTML をここにドロップ</p>
        <label className="button-link">
          ファイルを選ぶ
          <input
            type="file"
            accept="application/pdf,.pdf,text/html,.html"
            hidden
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void accept(file);
              event.target.value = '';
            }}
          />
        </label>
        <p className="dropzone-note">PDF はこの端末から出ません（サーバーは 127.0.0.1 のみで待ち受けています）。</p>
      </div>

      {message && (
        <p className="flash" role="status" aria-live="polite">
          {message}
          <button type="button" className="flash-close" aria-label="閉じる" onClick={() => setMessage(null)}>
            ×
          </button>
        </p>
      )}

      {health && (
        <p className="health">
          GROBID:{' '}
          <span className={health.grobid === 'up' ? 'is-good' : 'is-warn'}>
            {health.grobid === 'up' ? `接続済み (${health.grobidUrl})` : `未接続 (${health.grobidUrl})`}
          </span>
          {health.grobid === 'down' && '  — 簡易解析にフォールバックします。文の区切りと座標の精度が落ちます。'}
          <span className="health-data"> / データ: {health.dataDir}</span>
        </p>
      )}

      <ul className="document-list">
        {listError !== null && (
          <li className="pane-message">
            一覧を取得できませんでした: {listError}
            <br />
            LogiXiv のサーバーが動いているか確認してください（データは消えていません）。
          </li>
        )}
        {listError === null && documents.length === 0 && (
          <li className="pane-message">まだ論文がありません。</li>
        )}
        {documents.map((document) => (
          <li key={document.id}>
            <button type="button" className="document-row" onClick={() => onOpen(document.id)}>
              <span className="document-title">{document.title}</span>
              <span className="document-meta">
                {document.translated} / {document.total} 文 ·{' '}
                {document.parser === 'grobid' ? 'GROBID' : '簡易解析'} ·{' '}
                {new Date(document.updatedAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <span className="document-bar">
                <span
                  className="document-bar-fill"
                  style={{ width: `${document.total === 0 ? 0 : (document.translated / document.total) * 100}%` }}
                />
              </span>
            </button>
            <button
              type="button"
              className="document-delete"
              title="削除"
              onClick={() => {
                if (!window.confirm(`「${document.title}」を削除します。よろしいですか？`)) return;
                void api
                  .deleteDocument(document.id)
                  .then(reload)
                  .catch((cause: unknown) =>
                    setMessage(`削除に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`),
                  );
              }}
            >
              削除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

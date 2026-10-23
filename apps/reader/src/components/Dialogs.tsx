// ネイティブのダイアログ。Claude の設定とテンプレートの編集は、設定の画面（読解と AI / テンプレート）に移した。
import { useEffect, useRef, useState } from "react";

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return ref;
}

/** URL か arXiv の番号から論文を取り込む。失敗したときは閉じずに、サーバーの文言を欄の下に出す。 */
export function UrlImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (url: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // 取り込み中は Esc で閉じない
  const ref = useModal(busy ? noop : onClose);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const arxiv = /arxiv|^\d{4}\.\d{4,5}|^[a-z-]+(\.[A-Z]{2})?\/\d{7}/i.test(url.trim());
  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onImport(url.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <dialog ref={ref} aria-labelledby="url-title">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="dlg-body">
          <h2 id="url-title">URL から論文を追加</h2>
          <div className="record-field">
            <label className="field-label" htmlFor="import-url">PDF の URL か arXiv の番号</label>
            <span className="field-hint" id="import-url-hint">
              arXiv の論文は、題名・著者・年も自動で入ります。取り込んだ PDF は保存先フォルダに保存されます。保存先フォルダを公開の Git リポジトリで共有する場合は、PDF を含めないでください。
            </span>
            <input
              id="import-url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://arxiv.org/abs/2410.12345"
              disabled={busy}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={error ? "import-url-hint import-url-err" : "import-url-hint"}
            />
            {busy && arxiv && <p className="field-hint" style={{ marginTop: 6 }}>arXiv の間隔の決まりのため、数秒かかることがあります</p>}
            {error && <p className="err-msg" id="import-url-err" role="alert">{error}</p>}
          </div>
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn text" onClick={onClose} disabled={busy}>やめる</button>
          <button type="submit" className="btn primary" disabled={busy || !url.trim()}>{busy ? "取り込んでいます" : "取り込む"}</button>
        </div>
      </form>
    </dialog>
  );
}

const noop = () => undefined;

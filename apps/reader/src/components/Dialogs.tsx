import { useEffect, useRef, useState } from "react";
import { type AiSettings, DEFAULT_MODEL } from "../lib/claude.ts";
import { DEFAULT_TEMPLATE } from "../lib/defaultTemplate.ts";
import { TEMPLATE_PATH } from "../lib/papers.ts";
import { parseFields } from "../lib/template.ts";
import type { Vault } from "../lib/vault.ts";

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

export function SettingsDialog({ value, onSave, onClose }: { value: AiSettings; onSave: (s: AiSettings) => void; onClose: () => void }) {
  const ref = useModal(onClose);
  const [key, setKey] = useState(value.apiKey);
  const [model, setModel] = useState(value.model || DEFAULT_MODEL);
  return (
    <dialog ref={ref} aria-labelledby="settings-title">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); onSave({ apiKey: key.trim(), model: model.trim() || DEFAULT_MODEL }); }}>
        <div className="dlg-body">
          <h2 id="settings-title">Claude の設定</h2>
          <p style={{ marginTop: 0, fontSize: 14, color: "var(--text-sub)" }}>
            訳・用語の説明・数式の書き起こしに Claude を使います。API キーは Anthropic Console で発行できます。
          </p>
          <div className="record-field">
            <label className="field-label" htmlFor="api-key">API キー</label>
            <span className="field-hint" id="api-key-hint">このブラウザにだけ保存します。保管庫のフォルダには書き込みません。</span>
            <input id="api-key" aria-describedby="api-key-hint" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." />
          </div>
          <div className="record-field">
            <label className="field-label" htmlFor="model">モデル</label>
            <span className="field-hint" id="model-hint">初期設定は {DEFAULT_MODEL} です。</span>
            <input id="model" aria-describedby="model-hint" className="input" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <p className="notice" style={{ marginTop: 8 }}>
            Claude に送るのは、選択した範囲の文、その前後の本文、論文の題名です。数式では選択範囲の画像も送ります。PDF 全体は送りません。
          </p>
        </div>
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={onClose}>キャンセル</button>
          <button type="submit" className="btn primary">保存する</button>
        </div>
      </form>
    </dialog>
  );
}

export function TemplateDialog({ vault, onClose }: { vault: Vault; onClose: () => void }) {
  const ref = useModal(onClose);
  const [text, setText] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void vault.readText(TEMPLATE_PATH).then(setText, () => setText(DEFAULT_TEMPLATE));
  }, [vault]);
  const count = text ? parseFields(text).length : 0;
  return (
    <dialog ref={ref} className="wide" aria-labelledby="tpl-title">
      <div className="dlg-body">
        <h2 id="tpl-title">読解ノートのテンプレート</h2>
        <p style={{ marginTop: 0, fontSize: 14, color: "var(--text-sub)" }}>
          保管庫の <code>{TEMPLATE_PATH}</code> を編集します。変更は、これから取り込む論文のノートに使われます。
          入力欄は <code>&lt;!-- field: ID | 見出し | 説明 --&gt;</code> と <code>&lt;!-- /field --&gt;</code> で囲みます。
          直前の <code>##</code> 見出しが、記録タブでのまとまりになります。
        </p>
        <label className="visually-hidden" htmlFor="tpl">テンプレート</label>
        <textarea id="tpl" className="textarea template-editor" value={text ?? "読み込んでいます"} disabled={text === null} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <p className="field-hint" style={{ marginTop: 6 }} role="status">入力欄: {count} 個{msg && `　${msg}`}</p>
      </div>
      <div className="dlg-foot">
        <button type="button" className="btn text" style={{ marginRight: "auto" }} onClick={() => setText(DEFAULT_TEMPLATE)}>初期のテンプレートに戻す</button>
        <button type="button" className="btn" onClick={onClose}>閉じる</button>
        <button
          type="button"
          className="btn primary"
          disabled={text === null}
          onClick={async () => {
            if (text === null) return;
            await vault.writeText(TEMPLATE_PATH, text);
            setMsg("保存しました");
          }}
        >
          保存する
        </button>
      </div>
    </dialog>
  );
}

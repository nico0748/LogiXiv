// テンプレート: 保管庫の読解ノートのテンプレートをこのページで編集する（以前はダイアログ）。
import { useEffect, useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import { DEFAULT_TEMPLATE } from "../../lib/defaultTemplate.ts";
import { TEMPLATE_PATH } from "../../lib/papers.ts";
import { parseFields } from "../../lib/template.ts";

export function TemplatePage({ backend }: { backend: Backend }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void backend.readTemplate().then(
      (t) => {
        setText(t);
        setSaved(t);
      },
      () => {
        setText(DEFAULT_TEMPLATE);
        setSaved(null);
      },
    );
  }, [backend]);
  const count = text ? parseFields(text).length : 0;
  const dirty = text !== null && text !== saved;

  const save = async () => {
    if (text === null) return;
    try {
      await backend.writeTemplate(text);
      setSaved(text);
      setMsg({ ok: true, text: "保存しました" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="setting-item is-stacked" id="set-template">
      <div className="setting-item-info">
        <label className="setting-item-name" htmlFor="tpl">読解ノートのテンプレート</label>
        <div className="setting-item-description">
          保管庫の <code>{TEMPLATE_PATH}</code> です。変更は、これから取り込む論文のノートに使われます。
          入力欄は <code>&lt;!-- field: ID | 見出し | 説明 --&gt;</code> と <code>&lt;!-- /field --&gt;</code> で囲みます。直前の <code>##</code> 見出しが、記録タブでのまとまりになります。
        </div>
      </div>
      <div className="setting-item-control">
        <textarea
          id="tpl"
          className="textarea template-editor"
          value={text ?? "読み込んでいます"}
          disabled={text === null}
          onChange={(e) => {
            setText(e.target.value);
            setMsg(null);
          }}
          spellCheck={false}
        />
        <div className="row">
          <span className="field-hint" role="status">
            入力欄: {count} 個{dirty ? "・保存していない変更があります" : ""}
            {msg && <span className={msg.ok ? "check-ok" : "check-err"}>　{msg.text}</span>}
          </span>
          <span className="spacer" />
          <button type="button" className="btn text" onClick={() => setText(DEFAULT_TEMPLATE)}>初期のテンプレートに戻す</button>
          <button type="button" className="btn primary" disabled={!dirty} onClick={() => void save()}>保存する</button>
        </div>
      </div>
    </div>
  );
}

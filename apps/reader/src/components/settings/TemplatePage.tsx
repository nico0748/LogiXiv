// テンプレート: 保管庫の読解ノートのテンプレートをこのページで編集する（以前はダイアログ）。
// 保存していない変更は、ページを替えたり設定を閉じたりしても、この画面を開いている間は残す（下書き）。
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Backend } from "../../lib/backend.ts";
import { DEFAULT_TEMPLATE } from "../../lib/defaultTemplate.ts";
import { openHelp } from "../../lib/help.ts";
import { TEMPLATE_PATH } from "../../lib/papers.ts";
import { parseFields } from "../../lib/template.ts";

/** 保管庫ごとの保存していない下書き。増減を購読できる（ナビの印に使う） */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
function setDraft(name: string, text: string | null) {
  const had = drafts.has(name);
  if (text === null) drafts.delete(name);
  else drafts.set(name, text);
  if (had !== drafts.has(name)) for (const fn of listeners) fn();
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** 保存していないテンプレートの変更があるか */
export function useTemplateDraft(backend: Backend): boolean {
  const get = () => drafts.has(backend.name);
  return useSyncExternalStore(subscribe, get, get);
}

export function TemplatePage({ backend }: { backend: Backend }) {
  const [text, setTextState] = useState<string | null>(drafts.get(backend.name) ?? null);
  const [saved, setSaved] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const setText = (t: string) => {
    setTextState(t);
    setMsg(null);
    setDraft(backend.name, saved !== null && t === saved ? null : t);
  };
  useEffect(() => {
    void backend.readTemplate().then(
      (t) => {
        setSaved(t);
        setTextState((cur) => cur ?? t);
        if (drafts.get(backend.name) === t) setDraft(backend.name, null);
      },
      () => {
        setSaved(null);
        setTextState((cur) => cur ?? DEFAULT_TEMPLATE);
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
      setDraft(backend.name, null);
      setMsg({ ok: true, text: "保存しました" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="setting-item is-stacked" id="set-template">
      <div className="setting-item-info">
        <label className="setting-item-name" htmlFor="tpl">読解ノートのテンプレート</label>
        <div className="setting-item-description" id="tpl-desc">
          論文を取り込むと、このひな形から読解ノート（Markdown）を作ります。見出しごとに、右サイドバーの「記録」タブの入力欄ができます。
          変更は、これから取り込む論文のノートに使われます（いまあるノートは変わりません）。保存先は保管庫の <code>{TEMPLATE_PATH}</code> です。{" "}
          <button type="button" className="link-btn" onClick={() => openHelp("settings")}>書き方をヘルプで見る</button>
        </div>
        <details className="tpl-syntax">
          <summary>入力欄の書き方</summary>
          <p>
            入力欄にしたい所を <code>&lt;!-- field: ID | 見出し | 説明 --&gt;</code> と <code>&lt;!-- /field --&gt;</code> の行で囲みます。
            ID は英数字の名前（ノートの中で欄を見分けるのに使います）、見出しと説明は記録タブに出ます。直前の <code>##</code> 見出しが、記録タブでのまとまりになります。
          </p>
        </details>
      </div>
      <div className="setting-item-control">
        <textarea
          id="tpl"
          aria-describedby="tpl-desc"
          className="textarea template-editor"
          value={text ?? "読み込んでいます"}
          disabled={text === null}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="row">
          <span className="field-hint" role="status">
            入力欄: {count} 個
            {dirty && <span className="tpl-dirty">・保存していない変更があります</span>}
            {msg && <span className={msg.ok ? "check-ok" : "check-err"}>　{msg.text}</span>}
          </span>
          <span className="spacer" />
          {dirty && saved !== null && (
            <button type="button" className="btn text" onClick={() => setText(saved)}>変更を取り消す</button>
          )}
          <button type="button" className="btn text" onClick={() => setText(DEFAULT_TEMPLATE)}>初期のテンプレートに戻す</button>
          <button type="button" className="btn primary" disabled={!dirty} onClick={() => void save()}>保存する</button>
        </div>
      </div>
    </div>
  );
}

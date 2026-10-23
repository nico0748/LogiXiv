// 読解と AI: API キーとモデル、接続の確認、訳す言語、文体、訳語の固定、送る範囲。
// 値はこの端末（localStorage）にだけ保存する。保管庫には書かない。
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DEFAULT_STYLE, LANG_LABEL, glossaryItemToPair, mergeGlossary, termToPair } from "../../lib/aiPrompt.ts";
import { type Backend, ServerBackend } from "../../lib/backend.ts";
import { checkConnection, describeError } from "../../lib/claude.ts";
import type { ListsResponse } from "../../lib/lists.ts";
import { type ContextSize, DEFAULT_MODEL, type GlossPair, type TargetLang, patchPref, usePref } from "../../lib/prefs.ts";
import { SettingHeading, SettingItem, Segmented } from "./Setting.tsx";

/** モデルの候補。ここに無いものは欄に名前を入力する */
export const MODEL_CHOICES: { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5（初期設定）" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5（速い）" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5（もっと速く安い）" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1（最も高性能、高価）" },
];

const CONTEXT_DESC: Record<ContextSize, string> = {
  less: "前後 250 字ほど",
  normal: "前後 600 字ほど",
  more: "前後 1500 字ほど",
};

export function AiPage({ backend }: { backend: Backend }) {
  const ai = usePref("ai");
  const lang: TargetLang = ai.lang ?? "ja";
  const [showKey, setShowKey] = useState(false);
  const [check, setCheck] = useState<{ state: "busy" } | { state: "ok" | "err"; text: string } | null>(null);
  const custom = !MODEL_CHOICES.some((m) => m.id === ai.model);
  const [otherModel, setOtherModel] = useState(custom);
  const style = ai.style?.[lang] ?? "";

  const runCheck = async () => {
    setCheck({ state: "busy" });
    try {
      const name = await checkConnection(ai);
      setCheck({ state: "ok", text: `接続できました（${name}）。` });
    } catch (e) {
      setCheck({ state: "err", text: describeError(e) });
    }
  };

  return (
    <>
      <SettingHeading>Claude への接続</SettingHeading>
      <SettingItem
        id="api-key"
        name="API キー"
        htmlFor="api-key"
        desc={
          <>
            Anthropic Console で発行できます。この端末のブラウザにだけ保存し、保管庫のフォルダには書き込みません。
            <span className={`key-state${ai.apiKey ? " is-set" : ""}`} role="status">{ai.apiKey ? "API キーは設定済みです。" : "API キーはまだ設定していません。"}</span>
          </>
        }
      >
        <div className="row nowrap">
          <input
            id="api-key"
            className="input key-input"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={ai.apiKey}
            placeholder="sk-ant-..."
            onChange={(e) => {
              patchPref("ai", { apiKey: e.target.value.trim() });
              setCheck(null);
            }}
          />
          <button type="button" className="btn text sm" aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>{showKey ? "隠す" : "表示"}</button>
        </div>
      </SettingItem>
      <SettingItem id="model" name="モデル" htmlFor="ai-model" desc={`訳・用語・数式に使うモデルです。初期設定は ${DEFAULT_MODEL} です。`}>
        <div className="stack">
          <select
            id="ai-model"
            className="select"
            value={otherModel ? "__other" : ai.model}
            onChange={(e) => {
              if (e.target.value === "__other") return setOtherModel(true);
              setOtherModel(false);
              patchPref("ai", { model: e.target.value });
              setCheck(null);
            }}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
            <option value="__other">ほかのモデル（名前を入力）</option>
          </select>
          {otherModel && (
            <input
              className="input"
              aria-label="モデルの名前"
              placeholder="claude-..."
              spellCheck={false}
              value={custom ? ai.model : ""}
              onChange={(e) => {
                patchPref("ai", { model: e.target.value.trim() || DEFAULT_MODEL });
                setCheck(null);
              }}
            />
          )}
        </div>
      </SettingItem>
      <SettingItem id="check" name="接続を確かめる" desc="API キーとモデルの名前が正しいかを確かめます。論文の文章は送りません。">
        <div className="stack end">
          <button type="button" className="btn" disabled={!ai.apiKey || check?.state === "busy"} onClick={() => void runCheck()}>
            {check?.state === "busy" ? "確かめています" : "接続を確かめる"}
          </button>
          {check && check.state !== "busy" && (
            <span className={check.state === "ok" ? "check-ok" : "check-err"} role={check.state === "ok" ? "status" : "alert"}>{check.text}</span>
          )}
        </div>
      </SettingItem>

      <SettingHeading>訳と説明</SettingHeading>
      <SettingItem id="lang" name="訳す言語" desc="訳と、用語・数式の説明を書く言語です。">
        <Segmented
          label="訳す言語"
          value={lang}
          options={[
            { value: "ja", label: "日本語" },
            { value: "en", label: "英語" },
          ]}
          onChange={(v) => patchPref("ai", { lang: v })}
        />
      </SettingItem>
      <SettingItem id="style" name="訳と説明の文体" htmlFor="ai-style" desc={`Claude に渡す書き方の方針です（${LANG_LABEL[lang]}で書くとき）。空にすると初期値を使います。`} stacked>
        <textarea
          id="ai-style"
          className="textarea style-editor"
          rows={7}
          value={style || DEFAULT_STYLE[lang]}
          onChange={(e) => {
            const v = e.target.value;
            patchPref("ai", { style: { ...ai.style, [lang]: v.trim() === DEFAULT_STYLE[lang].trim() ? "" : v } });
          }}
        />
        <div className="row">
          <span className="field-hint">{style ? "変更しています" : "初期値です"}</span>
          <span className="spacer" />
          <button type="button" className="btn text sm" disabled={!style} onClick={() => patchPref("ai", { style: { ...ai.style, [lang]: "" } })}>初期値に戻す</button>
        </div>
      </SettingItem>
      <Glossary backend={backend} pairs={ai.glossary ?? []} />

      <SettingHeading>送る内容</SettingHeading>
      <SettingItem id="context" name="送る範囲" desc={`選んだ文の前後の本文を、訳語や意味を文脈に合わせるために添えます。いま: ${CONTEXT_DESC[ai.context ?? "normal"]}`}>
        <Segmented
          label="送る範囲"
          value={ai.context ?? "normal"}
          options={[
            { value: "less", label: "少なめ" },
            { value: "normal", label: "標準" },
            { value: "more", label: "多め" },
          ]}
          onChange={(v) => patchPref("ai", { context: v })}
        />
      </SettingItem>
      <div className="notice settings-notice">
        Claude に送るのは、選んだ範囲の文、その前後の本文（上の量）、論文の題名、文体と訳語の固定（送る文に出てくる語だけ）です。数式では選んだ範囲の画像も送ります。PDF 全体やノートは送りません。
      </div>
    </>
  );
}

function Glossary({ backend, pairs }: { backend: Backend; pairs: GlossPair[] }) {
  const [en, setEn] = useState("");
  const [ja, setJa] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const save = (list: GlossPair[]) => patchPref("ai", { glossary: list });

  const add = () => {
    if (!en.trim() || !ja.trim()) return;
    const r = mergeGlossary(pairs, [{ en: en.trim(), ja: ja.trim() }]);
    if (!r.added) setMsg(`「${en.trim()}」は既にあります。`);
    else {
      save(r.list);
      setMsg("");
    }
    setEn("");
    setJa("");
  };

  // 用語集から取り込む。各論文の用語（「日本語（English）」の見出し）と、サーバー版では対訳の用語集も使う
  const importFromTerms = async () => {
    setBusy(true);
    setMsg("");
    try {
      const found: GlossPair[] = [];
      if (backend instanceof ServerBackend) {
        const res = await fetch("/api/lists");
        if (res.ok) {
          const data = (await res.json()) as ListsResponse;
          for (const v of data.vocab) {
            const p = v.source === "glossary" ? glossaryItemToPair(v.term, v.meaning) : termToPair(v.term);
            if (p) found.push(p);
          }
        }
      } else {
        for (const paper of await backend.listPapers()) {
          const a = await backend.loadAnnotations(paper.id).catch(() => null);
          for (const t of a?.terms ?? []) {
            const p = termToPair(t.term);
            if (p) found.push(p);
          }
        }
      }
      const r = mergeGlossary(pairs, found);
      save(r.list);
      setMsg(r.added ? `${r.added} 個を取り込みました。` : "新しく取り込める訳語はありませんでした。用語の見出しが「日本語（English）」の形のものを取り込みます。");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingItem
      id="glossary"
      name="訳語の固定"
      desc="英語の語を、決めた日本語で訳してもらいます。送る文にその語が出てくるときだけ指示に添えます。"
      stacked
    >
      {pairs.length > 0 && (
        <table className="gloss-table">
          <thead>
            <tr>
              <th scope="col">英語</th>
              <th scope="col">訳語</th>
              <th scope="col"><span className="visually-hidden">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => (
              <tr key={p.en}>
                <td>{p.en}</td>
                <td>
                  <input className="input sm" aria-label={`${p.en} の訳語`} value={p.ja} onChange={(e) => save(pairs.map((q, j) => (j === i ? { ...q, ja: e.target.value } : q)))} />
                </td>
                <td>
                  <button type="button" className="clickable-icon" aria-label={`${p.en} を消す`} title="消す" onClick={() => save(pairs.filter((_, j) => j !== i))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="row gloss-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input sm" aria-label="英語の語" placeholder="self-attention" value={en} onChange={(e) => setEn(e.target.value)} spellCheck={false} />
        <span aria-hidden="true" className="gloss-arrow">→</span>
        <input className="input sm" aria-label="訳語" placeholder="自己注意" value={ja} onChange={(e) => setJa(e.target.value)} />
        <button type="submit" className="btn sm" disabled={!en.trim() || !ja.trim()}>
          <Plus size={14} aria-hidden="true" />足す
        </button>
      </form>
      <div className="row">
        <button type="button" className="btn text sm" disabled={busy} onClick={() => void importFromTerms()}>{busy ? "取り込んでいます" : "用語集から取り込む"}</button>
        {msg && <span className="field-hint" role="status">{msg}</span>}
      </div>
    </SettingItem>
  );
}

// 情報: ショートカットの一覧（検索つき）と、このアプリについて（バージョン・保存先・動作モード・不具合報告用の情報）。
import { useMemo, useState } from "react";
import { type Backend, ServerBackend } from "../../lib/backend.ts";
import { SHORTCUTS, filterShortcuts } from "../../lib/shortcuts.ts";
import { appMode, buildReport, MODE_LABEL } from "../../lib/appInfo.ts";
import { SettingItem } from "./Setting.tsx";
import pkg from "../../../package.json";

export function ShortcutsPage() {
  const [q, setQ] = useState("");
  const list = useMemo(() => filterShortcuts(SHORTCUTS, q), [q]);
  const scopes = [...new Set(list.map((s) => s.scope))];
  return (
    <div id="set-shortcuts">
      <p className="settings-text">キーの割り当ては、いまは変えられません。</p>
      <label className="visually-hidden" htmlFor="shortcut-search">ショートカットを検索</label>
      <input id="shortcut-search" className="input" type="search" placeholder="キーや操作で探す" value={q} onChange={(e) => setQ(e.target.value)} />
      {scopes.map((scope) => (
        <section key={scope} className="shortcut-group" aria-label={scope}>
          <h3 className="setting-item-heading">{scope}</h3>
          {list
            .filter((s) => s.scope === scope)
            .map((s) => (
              <div key={s.keys + s.scope} className="setting-item shortcut-row">
                <div className="setting-item-info">
                  <div className="setting-item-name">{s.action}</div>
                </div>
                <div className="setting-item-control">
                  <span className="hotkeys">
                    {s.keys.split(" / ").map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="hotkey-sep">/</span>}
                        {k.split(" + ").map((part, j) => (
                          <span key={j}>
                            {j > 0 && <span className="hotkey-plus">+</span>}
                            <kbd>{part}</kbd>
                          </span>
                        ))}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            ))}
        </section>
      ))}
      {!list.length && <p className="settings-empty">「{q}」に当てはまる操作はありません。</p>}
    </div>
  );
}

export function AboutPage({ backend }: { backend: Backend }) {
  const [copied, setCopied] = useState(false);
  const mode = appMode(backend.kind, backend instanceof ServerBackend && backend.meta.desktop);
  const version = backend instanceof ServerBackend ? backend.meta.version || pkg.version : pkg.version;
  const where = backend instanceof ServerBackend ? backend.meta.dataRoot : backend.persistent ? `ブラウザで選んだフォルダ「${backend.name}」` : "メモリ（ページを閉じると消えます）";
  const report = buildReport({ version, mode, where, userAgent: navigator.userAgent, language: navigator.language, screen: `${window.innerWidth}×${window.innerHeight}` });
  return (
    <div id="set-about">
      <dl className="about-list">
        <dt>バージョン</dt>
        <dd>{version}</dd>
        <dt>動作モード</dt>
        <dd>{MODE_LABEL[mode]}</dd>
        <dt>保存先</dt>
        <dd><code className="path">{where}</code></dd>
      </dl>
      <SettingItem
        name="不具合報告用の情報"
        desc="不具合を知らせるときに、この内容を貼り付けてください。API キーや論文の内容は含みません。"
        stacked
      >
        <pre className="report-block" aria-label="不具合報告用の情報">{report}</pre>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(report).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            {copied ? "コピーしました" : "コピーする"}
          </button>
        </div>
      </SettingItem>
    </div>
  );
}

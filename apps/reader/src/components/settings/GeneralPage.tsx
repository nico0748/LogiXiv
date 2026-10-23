// 全般: 保存先フォルダ（サーバー版）・保管庫（1 ファイル版）と、起動時の動作。
import { useState } from "react";
import { type Backend, type Meta, ServerBackend, serverApi } from "../../lib/backend.ts";
import { setPref, usePref } from "../../lib/prefs.ts";
import { SettingItem, Segmented } from "./Setting.tsx";

export function GeneralPage({ backend, onSwitchVault }: { backend: Backend; onSwitchVault?: () => void }) {
  const startup = usePref("startup");
  return (
    <>
      {backend instanceof ServerBackend ? <DataRoot backend={backend} /> : <BrowserVault backend={backend} onSwitchVault={onSwitchVault} />}
      <SettingItem id="startup" name="起動時の動作" desc="PaperLens を開いたときに表示するものです。">
        <Segmented
          label="起動時の動作"
          value={startup}
          options={[
            { value: "last", label: "前回の論文を開く" },
            { value: "list", label: "論文一覧を開く" },
          ]}
          onChange={(v) => setPref("startup", v)}
        />
      </SettingItem>
    </>
  );
}

function DataRoot({ backend }: { backend: ServerBackend }) {
  const [meta, setMeta] = useState<Meta>(backend.meta);
  const [path, setPath] = useState(backend.meta.dataRoot);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const locked = meta.dataRootSource === "env";

  const apply = async (next: string) => {
    setMsg(null);
    try {
      const m = await serverApi.setDataRoot(next);
      setMeta(m);
      setPath(m.dataRoot);
      setMsg({ ok: true, text: "保存先を変えました。画面を読み直します。" });
      window.setTimeout(() => location.reload(), 600);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const pick = async () => {
    try {
      const r = await serverApi.pickFolder(meta.dataRoot);
      if (r.path) await apply(r.path);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const source = { env: "環境変数 PAPERLENS_DATA で指定", config: "設定ファイルで指定", default: "初期設定" }[meta.dataRootSource];

  return (
    <div className="setting-group" id="set-vault">
      <SettingItem
        name="保存先フォルダ"
        desc="論文の PDF と読解ノートを、このフォルダに普通のファイルとして保存します。Obsidian でこのフォルダを保管庫として開くと、同じノートを読み書きできます。"
        stacked
      >
        <dl className="kv">
          <dt>場所</dt>
          <dd><code className="path">{meta.dataRoot}</code></dd>
          <dt>決め方</dt>
          <dd>{source}</dd>
        </dl>
        {meta.desktop ? (
          <div className="row">
            <button className="btn" onClick={() => void pick()} disabled={locked}>別のフォルダを選ぶ</button>
            <button className="btn text" onClick={() => void serverApi.reveal(meta.dataRoot)}>フォルダを開く</button>
          </div>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void apply(path.trim());
            }}
          >
            <label className="visually-hidden" htmlFor="data-root">保存先フォルダの絶対パス</label>
            <input id="data-root" className="input input-grow" value={path} onChange={(e) => setPath(e.target.value)} disabled={locked} spellCheck={false} />
            <button className="btn" type="submit" disabled={locked || !path.trim() || path.trim() === meta.dataRoot}>変更する</button>
          </form>
        )}
        {locked && <p className="field-hint">環境変数で指定しているため、画面からは変えられません。</p>}
        {msg && <p className={msg.ok ? "notice" : "err-msg"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      </SettingItem>
    </div>
  );
}

function BrowserVault({ backend, onSwitchVault }: { backend: Backend; onSwitchVault?: () => void }) {
  return (
    <SettingItem
      id="vault"
      name="保管庫"
      desc={backend.persistent ? `ブラウザで選んだフォルダ「${backend.name}」に保存しています。` : "お試し用の保管庫です。内容はページを閉じると消えます。"}
    >
      {onSwitchVault && <button className="btn" onClick={onSwitchVault}>別の保管庫を開く</button>}
    </SettingItem>
  );
}

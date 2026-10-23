// データ: 設定の書き出しと読み込み（JSON、API キーは含めない）、取り込み時の段階、リセット。
// 保管庫そのものの書き出しは「フォルダを開く」で代わりにする（zip にはしない）。
import { useRef, useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import { STATUSES } from "../../lib/defaultTemplate.ts";
import { DISPLAY_PREFS, clearStoredLayout, clearStoredPositions, exportPrefs, importPrefs, resetPref, setPref, usePref } from "../../lib/prefs.ts";
import { RESET_LAYOUT_EVENT } from "../shell/useWorkspace.ts";
import { SettingHeading, SettingItem } from "./Setting.tsx";

type ResetKind = "positions" | "layout" | "display";

const RESET: Record<ResetKind, { name: string; desc: string; confirm: string }> = {
  positions: { name: "前回の位置", desc: "論文ごとに覚えている「前回の位置」を消します。次に開くと先頭から表示します。", confirm: "前回の位置をすべて消します。" },
  layout: { name: "画面の配置", desc: "左右のサイドバーの開閉と幅を初期に戻します。開いている論文はそのままです。", confirm: "画面の配置を初期に戻します。" },
  display: { name: "表示の設定", desc: "テーマ・アクセント色・文字の大きさ・PDF の倍率・文の枠・並び順を初期に戻します。", confirm: "表示の設定を初期に戻します。" },
};

export function DataPage({ backend }: { backend: Backend }) {
  const importStatus = usePref("importStatus");
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ask, setAsk] = useState<ResetKind | null>(null);
  const [done, setDone] = useState<string>("");

  const download = () => {
    const blob = new Blob([JSON.stringify(exportPrefs(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "paperlens-settings.json";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setMsg({ ok: true, text: "paperlens-settings.json を書き出しました。" });
  };

  const load = async (f: File) => {
    try {
      const names = importPrefs(await f.text());
      setMsg({ ok: true, text: names.length ? `${names.length} 個の設定を読み込みました。` : "読み込める設定がありませんでした。" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const reset = (k: ResetKind) => {
    setAsk(null);
    if (k === "positions") {
      const n = clearStoredPositions();
      setDone(`前回の位置を ${n} 件消しました。`);
    } else if (k === "display") {
      for (const n of DISPLAY_PREFS) resetPref(n);
      setDone("表示の設定を初期に戻しました。");
    } else {
      // 読み直さずにその場で戻す（1 ファイル版のお試しの保管庫はメモリにあり、読み直すと消えるため）。
      // 保存（localStorage と、サーバー版の workspace.json）は useWorkspace がすぐに行う
      clearStoredLayout();
      window.dispatchEvent(new Event(RESET_LAYOUT_EVENT));
      setDone("画面の配置を初期に戻しました。");
    }
  };

  return (
    <>
      <SettingHeading>設定のファイル</SettingHeading>
      <SettingItem
        id="export"
        name="設定の書き出しと読み込み"
        desc="表示・読解と AI・起動時の動作などを JSON のファイルにします。別の PC に移すときに使います。API キーは含めません。テンプレートは保管庫にあるので、保管庫ごと移してください。"
      >
        <div className="row nowrap">
          <button type="button" className="btn" onClick={download}>書き出す</button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>読み込む</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="設定のファイルを読み込む"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void load(f);
            }}
          />
        </div>
      </SettingItem>
      {msg && <p className={msg.ok ? "notice settings-notice" : "err-msg"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}

      <SettingHeading>取り込み</SettingHeading>
      <SettingItem id="import-status" name="取り込み時の段階" htmlFor="import-status" desc="この画面から新しく取り込んだ論文に付ける読解の段階です。AI エージェント（MCP）から取り込んだ論文は「未読」のままです。">
        <select id="import-status" className="select" value={importStatus || STATUSES[0]} onChange={(e) => setPref("importStatus", e.target.value === STATUSES[0] ? "" : e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </SettingItem>

      <SettingHeading>リセット</SettingHeading>
      <div id="set-reset">
        {(Object.keys(RESET) as ResetKind[]).map((k) => (
          <SettingItem key={k} name={RESET[k].name} desc={RESET[k].desc}>
            {ask === k ? (
              <div className="row nowrap confirm-row" role="group" aria-label={`${RESET[k].name}のリセットの確認`}>
                <span className="confirm-text">{RESET[k].confirm}</span>
                <button type="button" className="btn text sm" onClick={() => setAsk(null)}>やめる</button>
                <button type="button" className="btn danger sm" onClick={() => reset(k)}>戻す</button>
              </div>
            ) : (
              <button type="button" className="btn" onClick={() => setAsk(k)}>初期に戻す</button>
            )}
          </SettingItem>
        ))}
        {done && <p className="notice settings-notice" role="status">{done}</p>}
      </div>

      <SettingHeading>保管庫</SettingHeading>
      <SettingItem
        name="保管庫の書き出し"
        desc={
          backend.kind === "server"
            ? "論文と読解ノートは、保存先フォルダ（場所は「全般」にあります）にそのままあります。フォルダごとコピーしてください。"
            : "論文と読解ノートは、選んだフォルダにそのままあります。フォルダごとコピーしてください。"
        }
      />
    </>
  );
}

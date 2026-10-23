// 連携: AI エージェント（MCP）の登録方法と、Obsidian で保管庫として開く手順。
import { useEffect, useState } from "react";
import { type Backend, type McpInfo, ServerBackend, serverApi } from "../../lib/backend.ts";
import { ExternalLink } from "lucide-react";
import { SettingHeading, SettingItem, Toggle } from "./Setting.tsx";

export function McpPage({ backend }: { backend: Backend }) {
  if (!(backend instanceof ServerBackend)) {
    return (
      <div id="set-mcp">
        <p className="notice warn">いま開いているのは、サーバーを使わないブラウザだけの版です。AI エージェント（MCP）はこの版では使えません。</p>
        <p className="settings-text">
          Claude Desktop や Claude Code から PaperLens を操作するには、PaperLens を手元の PC でローカルサーバーかデスクトップ版として起動します。Node.js 22 以上が必要です。
          起動したあと、この設定のページに登録のコマンドが出ます。
        </p>
        <SettingHeading>取得と準備（初回だけ）</SettingHeading>
        <CopyBlock label="取得と準備のコマンド" text={"git clone https://github.com/nico0748/LogiXiv.git\ncd LogiXiv\nnpm install\nnpm run build\ncd apps/reader"} />
        <SettingHeading>起動する</SettingHeading>
        <p className="settings-text">デスクトップ版は <code>npm run app</code>、ブラウザで使うときは次のコマンドのあと http://127.0.0.1:5175 を開きます。</p>
        <CopyBlock label="ローカルサーバーを起動するコマンド" text={"npm run build\nnpm start"} />
        <p className="settings-text">
          詳しくは{" "}
          <a className="ext-link" href="https://github.com/nico0748/LogiXiv/blob/main/apps/reader/README.md#実行方法" target="_blank" rel="noreferrer">
            README の「実行方法」<ExternalLink size={11} aria-hidden="true" />
          </a>
          を見てください。
        </p>
      </div>
    );
  }
  return <McpServer />;
}

function McpServer() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [error, setError] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    serverApi.mcp().then(setInfo, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const tools = info?.tools.filter((t) => !readOnly || !t.write).length ?? 0;

  return (
    <div id="set-mcp">
      <p className="settings-text">
        MCP サーバーを登録すると、Claude Desktop や Claude Code などの AI エージェントが、この画面と同じ操作（論文の取り込み、本文の読み取り、マーカーと訳、用語、数式、記録欄の入力、読解の段階の変更）を行えます。
        アプリを起動していなくても使えます。起動中は、エージェントの変更がこの画面にすぐ反映されます。
      </p>
      {error && <p className="err-msg" role="alert">{error}</p>}
      {info && (
        <>
          <SettingItem name="状態" desc={info.built ? "MCP サーバーはビルド済みです。下の設定で登録できます。" : "MCP サーバーはまだビルドしていないため、ソースをそのまま動かす設定にしています（Node.js 22.6 以上が必要です）。npm run build を実行すると、ビルドしたものを使う設定に変わります。"}>
            <span className={`status-pill${info.built ? " is-ok" : " is-warn"}`}>{info.built ? "使えます" : "ソースのまま"}</span>
          </SettingItem>
          <SettingItem name="読み取りだけを許可する" desc="ノートを書き換えるツールを公開しません。下のコマンドと設定に反映します。">
            <Toggle label="読み取りだけを許可する" checked={readOnly} onChange={setReadOnly} />
          </SettingItem>

          <SettingHeading>Claude Code で使う</SettingHeading>
          <p className="settings-text">端末で次のコマンドを実行します。</p>
          <CopyBlock text={readOnly ? info.claudeCodeReadOnly : info.claudeCode} label="Claude Code のコマンド" />

          <SettingHeading>Claude Desktop で使う</SettingHeading>
          <p className="settings-text">
            設定ファイル <code className="path">{info.desktopConfigPath}</code> に次の内容を加え、Claude Desktop を再起動します。
            ほかの MCP サーバーを登録している場合は、<code>mcpServers</code> の中に <code>paperlens</code> の項目だけを足してください。
          </p>
          <CopyBlock text={readOnly ? info.desktopConfigReadOnly : info.desktopConfig} label="Claude Desktop の設定" />

          <SettingHeading>使えるツール（{tools} 個）</SettingHeading>
          <ul className="tool-list">
            {info.tools.map((t) => (
              <li key={t.name} className={readOnly && t.write ? "off" : undefined}>
                <code>{t.name}</code>
                <span>{t.title}</span>
                <span className={`tag ${t.write ? "tag-write" : ""}`}>{t.write ? "書き込み" : "読み取り"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-block">
      <pre aria-label={label}>{text}</pre>
      <button
        className="btn sm"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1600);
          });
        }}
      >
        {done ? "コピーしました" : "コピーする"}
      </button>
    </div>
  );
}

export function ObsidianPage({ backend }: { backend: Backend }) {
  const folder = backend instanceof ServerBackend ? backend.meta.dataRoot : backend.persistent ? `ブラウザで選んだフォルダ「${backend.name}」` : null;
  return (
    <>
      <p className="settings-text" id="set-obsidian">
        PaperLens の読解ノートは普通の Markdown ファイルです。保存先のフォルダを Obsidian の保管庫として開くと、同じノートを Obsidian でも読み書きできます。どちらで書き換えても、もう一方の画面に反映されます。
      </p>
      {folder ? (
        <SettingItem name="保存先" desc="このフォルダを Obsidian で開きます。" stacked>
          <code className="path">{folder}</code>
        </SettingItem>
      ) : (
        <p className="notice warn">いまはお試し用の保管庫（メモリ）です。Obsidian で開くには、最初の画面で端末のフォルダを選んでください。</p>
      )}
      <SettingHeading>手順</SettingHeading>
      <ol className="steps">
        <li>Obsidian を開き、左下の保管庫の切り替えから「保管庫を管理」を選びます。</li>
        <li>「フォルダを保管庫として開く」を押し、{folder ? "上の「保存先」のフォルダ" : "PaperLens で選んだフォルダ"}を選びます。</li>
        <li><code>papers/&lt;論文 ID&gt;/note.md</code> が論文ごとの読解ノートです。PDF も同じフォルダにあります。</li>
        <li>
          PaperLens の論文の画面で、上の帯の右にある外へ出る矢印のアイコン（<ExternalLink size={12} aria-label="Obsidian で開く" />、名前は「Obsidian で開く」）を押すと、そのノートを Obsidian で開けます。
          Obsidian の保管庫の名前がフォルダ名と同じときに使えます。
        </li>
      </ol>
      <SettingHeading>注意</SettingHeading>
      <ul className="steps">
        <li><code>_templates/</code>（読解ノートのテンプレート）と <code>.paperlens/</code>（画面の配置）のフォルダは消さないでください。</li>
        <li>記録欄を囲む <code>&lt;!-- field: … --&gt;</code> のコメントを消すと、PaperLens の記録タブに出なくなります。</li>
      </ul>
    </>
  );
}

import { useEffect, useState } from "react";
import { type Backend, type McpInfo, type Meta, ServerBackend, serverApi } from "../lib/backend.ts";
import { TEMPLATE_PATH } from "../lib/papers.ts";

interface Props {
  backend: Backend;
  aiReady: boolean;
  onOpenClaude: () => void;
  onOpenTemplate: () => void;
  onClose?: () => void;
}

export function SettingsPage({ backend, aiReady, onOpenClaude, onOpenTemplate, onClose }: Props) {
  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">設定</h1>
        {backend instanceof ServerBackend ? <DataRootSection backend={backend} /> : <BrowserVaultSection backend={backend} onClose={onClose} />}

        <section className="section" aria-labelledby="sec-claude">
          <h2 id="sec-claude">Claude（画面からの訳・用語・数式）</h2>
          <p>
            PDF の文を選んで「訳す」「用語を調べる」「数式にする」を押したときに使います。
            {aiReady ? "API キーは設定済みです。" : "API キーはまだ設定していません。"}
          </p>
          <button className="btn" onClick={onOpenClaude}>API キーとモデルを設定する</button>
        </section>

        <section className="section" aria-labelledby="sec-template">
          <h2 id="sec-template">読解ノートのテンプレート</h2>
          <p>
            保存先の <code>{TEMPLATE_PATH}</code> です。段階（<code>##</code> 見出し）ごとの記録欄を決めます。変更は、これから取り込む論文のノートに使われます。
          </p>
          <button className="btn" onClick={onOpenTemplate}>テンプレートを編集する</button>
        </section>

        {backend instanceof ServerBackend ? (
          <McpSection />
        ) : (
          <section className="section" aria-labelledby="sec-mcp">
            <h2 id="sec-mcp">AI エージェント（MCP）</h2>
            <p>
              Claude Desktop や Claude Code から PaperLens を操作するには、アプリをローカルサーバーかデスクトップ版で起動してください。
              起動方法は README の「実行方法」にあります。いま開いているのはサーバーを使わない版のため、この画面からは設定できません。
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function DataRootSection({ backend }: { backend: ServerBackend }) {
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
    <section className="section" aria-labelledby="sec-data">
      <h2 id="sec-data">保存先フォルダ</h2>
      <p>
        論文の PDF と読解ノートは、このフォルダに普通のファイルとして保存します。Obsidian でこのフォルダを保管庫として開くと、同じノートを読み書きできます。
      </p>
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
    </section>
  );
}

function McpSection() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [error, setError] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    serverApi.mcp().then(setInfo, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <section className="section" aria-labelledby="sec-mcp">
      <h2 id="sec-mcp">AI エージェント（MCP）</h2>
      <p>
        MCP サーバーを登録すると、Claude Desktop や Claude Code などの AI エージェントが、この画面と同じ操作（論文の取り込み、本文の読み取り、マーカーと訳、用語、数式、記録欄の入力、読解の段階の変更）を行えます。
        アプリを起動していなくても使えます。起動中は、エージェントの変更がこの画面にすぐ反映されます。
      </p>
      {error && <p className="err-msg" role="alert">{error}</p>}
      {info && (
        <>
          <label className="check">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            読み取りだけを許可する（ノートを書き換えるツールを公開しない）
          </label>

          <h3>Claude Code で使う</h3>
          <p>端末で次のコマンドを実行します。</p>
          <CopyBlock text={readOnly ? info.claudeCodeReadOnly : info.claudeCode} label="Claude Code のコマンド" />

          <h3>Claude Desktop で使う</h3>
          <p>
            設定ファイル <code className="path">{info.desktopConfigPath}</code> に次の内容を加え、Claude Desktop を再起動します。
            ほかの MCP サーバーを登録している場合は、<code>mcpServers</code> の中に <code>paperlens</code> の項目だけを足してください。
          </p>
          <CopyBlock text={readOnly ? info.desktopConfigReadOnly : info.desktopConfig} label="Claude Desktop の設定" />

          {!info.built && (
            <p className="notice warn">
              MCP サーバーはまだビルドしていないため、ソースをそのまま動かす設定にしています（Node.js 22.6 以上が必要です）。
              <code>npm run build</code> を実行すると、ビルドしたものを使う設定に変わります。
            </p>
          )}

          <h3>使えるツール（{info.tools.filter((t) => !readOnly || !t.write).length} 個）</h3>
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
    </section>
  );
}

function CopyBlock({ text, label }: { text: string; label: string }) {
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

function BrowserVaultSection({ backend, onClose }: { backend: Backend; onClose?: () => void }) {
  return (
    <section className="section" aria-labelledby="sec-data">
      <h2 id="sec-data">保管庫</h2>
      <p>
        {backend.persistent
          ? `ブラウザで選んだフォルダ「${backend.name}」に保存しています。`
          : "お試し用の保管庫です。内容はページを閉じると消えます。"}
      </p>
      {onClose && <button className="btn" onClick={onClose}>別の保管庫を開く</button>}
    </section>
  );
}

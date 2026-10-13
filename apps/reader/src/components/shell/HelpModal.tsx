// 使い方とキーボード操作の一覧。
import { Modal } from "./Modal.tsx";

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const KEYS: [string, string][] = [
  [`${mod} + \\`, "左サイドバー（論文一覧）を開く・閉じる"],
  [`${mod} + Shift + L`, "用語・数式のリストを開く"],
  ["Esc", "開いている画面（リスト・設定・ヘルプ）を閉じる"],
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="ヘルプ" onClose={onClose} className="mod-help">
      <div className="page">
        <div className="page-inner">
          <h1 className="page-title">ヘルプ</h1>
          <section className="section" aria-labelledby="help-flow">
            <h2 id="help-flow">読み方</h2>
            <p>
              左端の「論文一覧」から PDF を取り込む（またはサイドバーへドロップする）と、テンプレートから読解ノートを作ります。
              PDF の文を選ぶと、マーカー・訳・用語・数式を記録でき、右のサイドバーに一覧が出ます。記録は保管庫の Markdown にそのまま残ります。
            </p>
          </section>
          <section className="section" aria-labelledby="help-keys">
            <h2 id="help-keys">キーボード操作</h2>
            <dl className="kv">
              {KEYS.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt><kbd>{k}</kbd></dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="section" aria-labelledby="help-side">
            <h2 id="help-side">画面の配置</h2>
            <p>サイドバーの端をつまむと幅を変えられます（ダブルクリックで元の幅）。開閉と幅は保管庫の <code>.paperlens/workspace.json</code> に保存し、次に開いたときに戻します。</p>
          </section>
        </div>
      </div>
    </Modal>
  );
}

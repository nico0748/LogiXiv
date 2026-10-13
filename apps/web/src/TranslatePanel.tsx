import { useEffect, useState } from 'react';
import type { Health } from './api.ts';

/**
 * 「ここから Claude に訳してもらう」を画面の中に置く。
 *
 * これが無かった頃、製品の中核機能は**手順書にしか存在しなかった**。
 * 取り込み直後の画面に出るのは、左に英語の PDF、右に同じ英語が 300 行、
 * すべて（未訳）。押せるのは「書き出し」「取り込み」「再解析」だけで、
 * Claude の C の字も出てこない。何をすればいいのか分からないまま、
 * 「解析に失敗したのだろう」と再解析を押して何も変わらない、が起きていた。
 *
 * 出すのは 3 つだけ。(1) 接続の設定をそのまま貼れる形で、(2) Claude に言う文、
 * (3) 今つながっているかどうか。長い説明は手順書に任せる。
 *
 * (1) では**貼り先のファイル名**まで出す。JSON だけ渡して「MCP 設定に足す」と
 * 言っていた頃、はじめての人はここで完全に止まった。設定が JSON で、
 * クリップボードに入っていて、置き場所だけが分からない、という止まり方をする。
 * 置き場所は OS ごとに違うので、動いている本体に訊く（health.mcp.configPath）。
 *
 * (3) は「押しても何も始まらない」への答え。このボタンは一番目立つ青なので
 * 「押せば訳が進む」と読まれるが、実際は説明が開くだけだった。設定前と設定後で
 * 画面が 1 文字も変わらないので、自分の設定が効いているのか、待てばいいのかが
 * 判断できない。MCP から本体に呼び出しが来たかどうかを、そのまま出す。
 */

interface Props {
  health: Health | null;
  documentTitle: string;
  /** 未訳の異なり文の数。0 なら「終わっています」と出す。 */
  remaining: number;
  /** 直近に訳が書き込まれた時刻（SSE で更新）。 */
  lastWriteAt: number | null;
  onClose: () => void;
}

/** 「3 秒前」程度で十分。時計を出しても読み手がやることは変わらない。 */
function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分前`;
  return `${Math.round(minutes / 60)} 時間前`;
}

function configJson(entry: string | null, url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'paperlens-server': {
          command: 'node',
          args: [entry ?? '<PaperLens を置いた場所>/packages/mcp/dist/index.js'],
          env: { PAPERLENS_SERVER_URL: url },
        },
      },
    },
    null,
    2,
  );
}

export function TranslatePanel({ health, documentTitle, remaining, lastWriteAt, onClose }: Props): React.JSX.Element {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const entry = health?.mcp?.entry ?? null;
  const url = health?.mcp?.url ?? 'http://127.0.0.1:4173';
  const sentence = `PaperLens の「${documentTitle}」を翻訳して`;

  useEffect(() => {
    if (notice === null) return;
    // 失敗のときは読む時間が要る。成功はすぐ消えてよい。
    const timer = setTimeout(() => setNotice(null), notice.ok ? 1800 : 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * クリップボードは http://127.0.0.1 では使えることが多いが、保証はない。
   * 権限が下りない環境も、そもそも API が無い環境もある。
   * 黙って何も起きないのがいちばん困る（押したのに進めない）ので、
   * 使えないときは「上の枠を選んで手でコピーしてください」と言い切る。
   */
  const copy = (label: string, text: string): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setNotice({ ok: false, text: `${label}をコピーできませんでした。上の枠を選んで手でコピーしてください。` });
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => setNotice({ ok: true, text: `${label}をコピーしました` }))
      .catch(() =>
        setNotice({ ok: false, text: `${label}をコピーできませんでした。上の枠を選んで手でコピーしてください。` }),
      );
  };

  const active = lastWriteAt !== null && Date.now() - lastWriteAt < 60_000;
  const contactedAt = health?.mcp?.lastContactAt ?? null;
  const configPath = health?.mcp?.configPath ?? null;
  const addCommand = health?.mcp?.addCommand ?? null;

  return (
    <div className="translate-panel" role="dialog" aria-label="Claude に翻訳してもらう">
      <div className="translate-head">
        <strong>Claude に翻訳してもらう</strong>
        <button type="button" className="flash-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
      </div>

      {remaining === 0 ? (
        <p className="translate-note">この論文は訳し終わっています。</p>
      ) : (
        <p className="translate-note">
          未訳 {remaining} 文。翻訳は Claude が MCP 経由で行います（翻訳 API のキーは要りません）。
          {active && <strong className="translate-live"> — いま書き込みが届いています。</strong>}
        </p>
      )}

      <ol className="translate-steps">
        <li>
          <span>
            Claude Desktop の設定ファイルにこれを足して、Claude を起動し直す（一度だけ）
          </span>
          {configPath && (
            <p className="translate-path">
              貼り先: <code>{configPath}</code>
              <button type="button" className="translate-inline" onClick={() => copy('貼り先のパス', configPath)}>
                パスをコピー
              </button>
            </p>
          )}
          <pre className="translate-code">{configJson(entry, url)}</pre>
          <button type="button" onClick={() => copy('設定', configJson(entry, url))}>
            設定をコピー
          </button>
          {addCommand && (
            <details className="translate-alt">
              <summary>Claude Code を使っている場合（端末で 1 行）</summary>
              <pre className="translate-code">{addCommand}</pre>
              <button type="button" onClick={() => copy('コマンド', addCommand)}>
                コマンドをコピー
              </button>
            </details>
          )}
          {entry === null && (
            <p className="translate-warn">
              MCP サーバーがまだビルドされていません。<code>npm run build</code> を実行してください。
            </p>
          )}
        </li>
        <li>
          <span>Claude にこう言う</span>
          <pre className="translate-code">{sentence}</pre>
          <button type="button" onClick={() => copy('文', sentence)}>
            この文をコピー
          </button>
        </li>
        <li>
          <span>この画面はそのままで構いません。訳は届いたそばから反映されます。</span>
          {contactedAt === null ? (
            <p className="translate-status is-waiting">
              まだ Claude からの接続はありません。設定を足したら Claude を起動し直してください。
              つながるとここの表示が変わります。
            </p>
          ) : (
            <p className="translate-status is-connected">
              Claude とつながっています（最後のやりとり: {relativeTime(contactedAt)}）。
            </p>
          )}
        </li>
      </ol>

      {notice && (
        <p
          className={notice.ok ? 'translate-copied' : 'translate-copied is-failed'}
          role="status"
          aria-live="polite"
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

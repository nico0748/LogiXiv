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

function configJson(entry: string | null, url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        logixiv: {
          command: 'node',
          args: [entry ?? '<LogiXiv を置いた場所>/packages/mcp/dist/index.js'],
          env: { LOGIXIV_URL: url },
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
  const sentence = `LogiXiv の「${documentTitle}」を翻訳して`;

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
          <span>Claude 側の MCP 設定にこれを足す（一度だけ）</span>
          <pre className="translate-code">{configJson(entry, url)}</pre>
          <button type="button" onClick={() => copy('設定', configJson(entry, url))}>
            設定をコピー
          </button>
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

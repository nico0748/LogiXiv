import { useState } from 'react';
import type { PaperDocument } from './api.ts';

/**
 * 再解析のやり直し口。
 *
 * これまでツールバーの「再解析」は、押した瞬間に `parser: 'auto'` で走っていた。
 * 確認も取り消しも無く、解析方式を選ぶ手段も無い。
 *
 * ところが解析方式が変わると文の切れ目が変わり、訳が結びつく先（ハッシュ）が変わる。
 * 簡易解析で 40 文すべて訳し終えた論文に GROBID を立ててから 1 回押すと、
 * 7 文ぶんの訳が画面から消えた。**訳そのものは残っている**（結び先を失っただけで、
 * 元の方式で解析し直せば全部戻る）のに、画面には「対応なし 7 件」としか出ず、
 * 消えていないことも、戻し方も、どこにも書かれていなかった。
 * `auto` は GROBID が生きている限り必ず GROBID を選ぶので、
 * 画面からは元に戻す操作そのものが存在しなかった。
 *
 * だから出すのは 3 つ。(1) 何が起きるか、(2) 方式を選ばせる、(3) 外れても戻せると言う。
 */

export type ParserChoice = 'auto' | 'grobid' | 'fallback';

interface Props {
  document: PaperDocument;
  grobidUp: boolean;
  busy: boolean;
  onRun: (parser: ParserChoice) => Promise<void>;
  onClose: () => void;
}

const LABELS: Record<ParserChoice, string> = {
  auto: '自動（GROBID があれば GROBID）',
  grobid: 'GROBID で',
  fallback: '簡易解析で（pdf.js）',
};

export function ReparsePanel({ document: paper, grobidUp, busy, onRun, onClose }: Props): React.JSX.Element {
  const current = paper.structure.parser;
  const [choice, setChoice] = useState<ParserChoice>(current === 'grobid' ? 'grobid' : 'fallback');
  const translations = Object.keys(paper.annotations.translations).length;
  const edits = (paper.annotations.sentenceEdits ?? []).filter((edit) => !edit.detached).length;
  // 「自動」は GROBID が生きていれば GROBID を選ぶので、いまが簡易解析なら
  // 方式は変わる。自動のときだけ注意書きが出ないのは、いちばん変わる選択肢で
  // いちばん黙っていることになる。
  const willSwitch =
    choice === 'auto'
      ? grobidUp
        ? current !== 'grobid'
        : current !== 'fallback'
      : choice !== current;

  return (
    <div className="translate-panel" role="dialog" aria-label="再解析">
      <div className="translate-head">
        <strong>同じ PDF を解析し直す</strong>
        <button type="button" className="flash-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
      </div>

      <p className="translate-note">
        いまの方式: <strong>{current === 'grobid' ? 'GROBID 解析' : '簡易解析'}</strong>
        {translations > 0 && `／訳 ${translations} 件`}
      </p>

      <div className="reparse-choices">
        {(['auto', 'grobid', 'fallback'] as ParserChoice[]).map((value) => (
          <label key={value} className="reparse-choice">
            <input
              type="radio"
              name="reparse-parser"
              checked={choice === value}
              onChange={() => setChoice(value)}
            />
            <span>{LABELS[value]}</span>
            {value === 'grobid' && !grobidUp && <span className="reparse-warn">（いま届いていません）</span>}
          </label>
        ))}
      </div>

      {edits > 0 && (
        <p className="translate-note">
          手で直した区切り {edits} 件は、当たらなくなっても記録として残ります。元の方式に戻せば
          そのまま効き直します。
        </p>
      )}

      {translations > 0 && willSwitch && (
        <p className="translate-note reparse-caution">
          方式を変えると文の切れ目が変わるので、訳の一部が文から外れることがあります。
          <strong>訳が消えることはありません。</strong>
          元の方式（{current === 'grobid' ? 'GROBID' : '簡易解析'}）でもう一度解析し直せば、外れた訳は戻ります。
          {choice === 'auto' && grobidUp && current !== 'grobid' && (
            <>
              <br />
              「自動」は GROBID が届いているので GROBID を選びます。
            </>
          )}
        </p>
      )}

      <div className="card-actions">
        <button type="button" disabled={busy} onClick={() => void onRun(choice)}>
          {busy ? '解析中…' : 'この方式で解析し直す'}
        </button>
        <button type="button" onClick={onClose}>
          やめる
        </button>
      </div>
    </div>
  );
}

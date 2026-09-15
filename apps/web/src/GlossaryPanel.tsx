import { useState } from 'react';
import { api, type PaperDocument } from './api.ts';

/**
 * 用語集の表示と編集。
 *
 * これまで用語集は MCP からしか触れず、画面には一度も出てこなかった。
 * Claude がどの訳語を使っているのかを人が見られない、直せない、という状態で、
 * 「訳語を揃える」という共同作業の要になる情報が片側からしか見えていなかった。
 *
 * 訳語を変えたときは、既に書いた訳も追随させられる。ただし**件数だけを見せて
 * 走らせない**。日本語には語の切れ目が無いので「学習 → ラーニング」は
 * 機械学習も学習率も巻き込む。しかも訳語を変えたくなるのは論文を訳し込んだ後で、
 * 人手で直した訳まで対象に入る。いちばん積み上がった時点で、いちばん戻せない。
 * だから、何がどう変わるかを 1 件ずつ見せて、選ばせる。
 *
 * 用語集そのものの操作も 1 件ずつ送る。画面が持っている一覧をまるごと PUT すると、
 * 開いている間に Claude が足した語が黙って消える。
 */

interface Props {
  document: PaperDocument;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
  onMessage: (text: string) => void;
}

interface Candidate {
  sentenceHash: string;
  before: string;
  after: string;
  revisedByHuman: boolean;
}

interface Pending {
  term: string;
  from: string;
  to: string;
  total: number;
  candidates: Candidate[];
  chosen: Set<string>;
}

/** 変更点だけを目立たせて出す。長い訳文の中の 1 語を探させない。 */
function Diff({ before, after, from, to }: { before: string; after: string; from: string; to: string }) {
  const parts = before.split(from);
  return (
    <p className="replace-diff">
      {parts.map((part, index) => (
        <span key={index}>
          {part}
          {index < parts.length - 1 && (
            <>
              <del>{from}</del>
              <ins>{to}</ins>
            </>
          )}
        </span>
      ))}
      {after === before && <span className="replace-nochange">（変化なし）</span>}
    </p>
  );
}

export function GlossaryPanel({ document: paper, onChanged, onClose, onMessage }: Props): React.JSX.Element {
  const glossary = paper.annotations.glossary;
  const [term, setTerm] = useState('');
  const [translation, setTranslation] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ term: string; value: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async (label: string, task: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    try {
      const note = await task();
      await onChanged();
      if (note) onMessage(note);
    } catch (cause) {
      onMessage(`${label}に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 訳語を保存し、既訳に波及する候補があれば確認の一覧を出す。 */
  const save = (entry: { term: string; translation: string; note: string | null }, next: string): Promise<void> =>
    run('訳語の変更', async () => {
      const value = next.trim();
      if (value.length === 0) throw new Error('訳語が空です');
      if (value === entry.translation) {
        setEditing(null);
        return null;
      }
      await api.putGlossaryEntry(paper.id, { ...entry, translation: value });
      setEditing(null);

      const preview = await api.previewTermReplacement(paper.id, entry.translation, value);
      if (preview.total === 0) return `「${entry.term}」の訳語を「${value}」にしました。`;
      setPending({
        term: entry.term,
        from: entry.translation,
        to: value,
        total: preview.total,
        candidates: preview.candidates,
        // 既定は全部選ぶが、1 件ずつ外せる。
        chosen: new Set(preview.candidates.map((c) => c.sentenceHash)),
      });
      return null;
    });

  const applyPending = (): Promise<void> =>
    run('既訳の置き換え', async () => {
      if (!pending) return null;
      const edits = pending.candidates
        .filter((candidate) => pending.chosen.has(candidate.sentenceHash))
        .map(({ sentenceHash, before, after }) => ({ sentenceHash, before, after }));
      setPending(null);
      if (edits.length === 0) return '既訳はそのままにしました。';
      const result = await api.applyTranslationEdits(paper.id, edits);
      const stale =
        result.stale.length > 0
          ? `（${result.stale.length} 件は確認中に別の書き込みが入ったため飛ばしました。もう一度開くと出てきます）`
          : '';
      return `既訳 ${result.applied} 件を置き換えました${stale}`;
    });

  if (pending) {
    const shown = pending.candidates.length;
    return (
      <div className="glossary-panel" role="dialog" aria-label="既訳の置き換え確認">
        <div className="translate-head">
          <strong>
            「{pending.from}」→「{pending.to}」に置き換える訳を選ぶ
          </strong>
          <button type="button" className="flash-close" aria-label="閉じる" onClick={() => setPending(null)}>
            ×
          </button>
        </div>
        <p className="translate-note">
          日本語には語の切れ目がないので、意図しない語まで巻き込むことがあります。変わる場所を確かめてください。
          {pending.total > shown && `（${pending.total} 件中 ${shown} 件を表示）`}
        </p>

        <ul className="replace-list">
          {pending.candidates.map((candidate) => (
            <li key={candidate.sentenceHash}>
              <label>
                <input
                  type="checkbox"
                  checked={pending.chosen.has(candidate.sentenceHash)}
                  onChange={(event) => {
                    const chosen = new Set(pending.chosen);
                    if (event.target.checked) chosen.add(candidate.sentenceHash);
                    else chosen.delete(candidate.sentenceHash);
                    setPending({ ...pending, chosen });
                  }}
                />
                <Diff
                  before={candidate.before}
                  after={candidate.after}
                  from={pending.from}
                  to={pending.to}
                />
                {candidate.revisedByHuman && <span className="replace-human">人手修正済み</span>}
              </label>
            </li>
          ))}
        </ul>

        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void applyPending()}>
            選んだ {pending.chosen.size} 件を置き換える
          </button>
          <button type="button" onClick={() => setPending({ ...pending, chosen: new Set() })}>
            全部外す
          </button>
          <button
            type="button"
            onClick={() =>
              setPending({ ...pending, chosen: new Set(pending.candidates.map((c) => c.sentenceHash)) })
            }
          >
            全部選ぶ
          </button>
          <button type="button" onClick={() => setPending(null)}>
            やめる
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="glossary-panel" role="dialog" aria-label="用語集">
      <div className="translate-head">
        <strong>用語集（{glossary.length}）</strong>
        <button type="button" className="flash-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="translate-note">
        ここに載せた訳語を Claude が優先します。訳語を変えると、既に書いた訳も置き換えるか確かめます。
      </p>

      {glossary.length === 0 && <p className="pane-message">まだ登録がありません。</p>}

      <ul className="glossary-list">
        {glossary.map((entry) => (
          <li key={entry.term}>
            <span className="glossary-term" lang="en">
              {entry.term}
            </span>
            {editing?.term === entry.term ? (
              <input
                className="glossary-input"
                value={editing.value}
                autoFocus
                aria-label={`${entry.term} の訳語`}
                onChange={(event) => setEditing({ term: entry.term, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditing(null);
                  if (event.key === 'Enter') void save(entry, editing.value);
                }}
                // 書きかけを黙って捨てない。外れたときも保存する。
                onBlur={() => void save(entry, editing.value)}
              />
            ) : (
              <button
                type="button"
                className="glossary-value"
                title="押すと訳語を直せます"
                onClick={() => setEditing({ term: entry.term, value: entry.translation })}
              >
                {entry.translation}
              </button>
            )}
            {entry.note && <span className="glossary-note">{entry.note}</span>}
            <button
              type="button"
              className="glossary-remove"
              aria-label={`${entry.term} を削除`}
              disabled={busy}
              onClick={() =>
                void run('用語の削除', async () => {
                  await api.deleteGlossaryEntry(paper.id, entry.term);
                  return null;
                })
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="glossary-add">
        <input
          value={term}
          placeholder="原語"
          aria-label="原語"
          lang="en"
          onChange={(event) => setTerm(event.target.value)}
        />
        <input
          value={translation}
          placeholder="訳語"
          aria-label="訳語"
          onChange={(event) => setTranslation(event.target.value)}
        />
        <button
          type="button"
          disabled={busy || term.trim().length === 0 || translation.trim().length === 0}
          onClick={() =>
            void run('用語の追加', async () => {
              await api.putGlossaryEntry(paper.id, {
                term: term.trim(),
                translation: translation.trim(),
                note: null,
              });
              setTerm('');
              setTranslation('');
              return null;
            })
          }
        >
          追加
        </button>
      </div>
    </div>
  );
}

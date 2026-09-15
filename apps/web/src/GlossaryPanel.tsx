import { useState } from 'react';
import { api, type PaperDocument } from './api.ts';

/**
 * 用語集の表示と編集。
 *
 * これまで用語集は MCP からしか触れず、画面には一度も出てこなかった。
 * Claude がどの訳語を使っているのかを人が見られない、直せない、という状態で、
 * 「訳語を揃える」という共同作業の要になる情報が片側からしか見えていなかった。
 *
 * 訳語を変えたときは、**既に書いた訳も追随させる**。用語集は本来
 * 「これから訳すとき」にしか効かないので、途中で変えると前半と後半で
 * 訳語が違う論文ができる。検索して 1 件ずつ直すのは、100 件あれば実質やらない。
 */

interface Props {
  document: PaperDocument;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
  onMessage: (text: string) => void;
}

export function GlossaryPanel({ document: paper, onChanged, onClose, onMessage }: Props): React.JSX.Element {
  const glossary = paper.annotations.glossary;
  const [term, setTerm] = useState('');
  const [translation, setTranslation] = useState('');
  const [busy, setBusy] = useState(false);
  /** 訳語を書き換えている行と、その新しい値。 */
  const [editing, setEditing] = useState<{ term: string; value: string } | null>(null);

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

  const save = (entry: { term: string; translation: string; note: string | null }, next: string): Promise<void> =>
    run('訳語の変更', async () => {
      if (next.trim().length === 0) throw new Error('訳語が空です');
      await api.setGlossary(paper.id, [
        ...glossary.filter((g) => g.term !== entry.term),
        { ...entry, translation: next.trim() },
      ]);
      setEditing(null);
      // 既訳を追随させるか、件数を見てから決める。
      const check = await api.replaceTerm(paper.id, entry.translation, next.trim(), { dryRun: true });
      if (check.applied === 0) return `「${entry.term}」の訳語を「${next.trim()}」にしました。`;
      const human = check.revisedByHuman > 0 ? `（うち人手修正済み ${check.revisedByHuman} 件）` : '';
      if (!window.confirm(`既にある訳 ${check.applied} 件${human}の「${entry.translation}」も置き換えますか？`)) {
        return `訳語だけ変えました（既訳 ${check.applied} 件はそのままです）。`;
      }
      const result = await api.replaceTerm(paper.id, entry.translation, next.trim(), {});
      return `訳語を変え、既訳 ${result.applied} 件を置き換えました。`;
    });

  return (
    <div className="glossary-panel" role="dialog" aria-label="用語集">
      <div className="translate-head">
        <strong>用語集（{glossary.length}）</strong>
        <button type="button" className="flash-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="translate-note">
        ここに載せた訳語を Claude が優先します。訳語を変えると、既に書いた訳も追随させるか訊きます。
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
                onBlur={() => setEditing(null)}
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
                  await api.setGlossary(
                    paper.id,
                    glossary.filter((g) => g.term !== entry.term),
                  );
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
              await api.addGlossary(paper.id, [{ term: term.trim(), translation: translation.trim() }]);
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

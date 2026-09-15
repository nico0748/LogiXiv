import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, PaperDocument, Sentence } from './api.ts';

/**
 * 1 文 = 1 カードのサイドバー。
 *
 * 訳は「クリックしたら編集できる」だけにしてある。編集モードの切り替えを
 * 明示的なボタンにすると、読みながら気になった 1 文を直す動作が重くなるため。
 * 保存すると revisedByHuman が立ち、以後 Claude の訳で上書きされなくなる。
 *
 * 見出しとカードは .sidebar の直接の子にする。ラッパの <div> で包むと
 * その div が position:sticky の包含ブロックになり、見出しがカード 1 枚ぶんで
 * 流れて消える（＝どの節を読んでいるか分からなくなる）。
 */

interface Props {
  document: PaperDocument;
  selectedId: string | null;
  filter: string;
  visibleSentences: Sentence[];
  onSelect: (sentenceId: string, origin: 'pdf' | 'sidebar') => void;
  onSaveTranslation: (hash: string, text: string) => Promise<boolean>;
  onAddNote: (hash: string, body: string) => Promise<boolean>;
  onDeleteNote: (noteId: string) => Promise<boolean>;
  onToggleSkip: (hash: string, skip: boolean) => Promise<boolean>;
  scrollTarget: { id: string; token: number } | null;
}

export function Sidebar(props: Props): React.JSX.Element {
  const { document: paper, selectedId, visibleSentences, scrollTarget } = props;
  const listRef = useRef<HTMLDivElement>(null);

  const notesByHash = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const note of paper.annotations.notes) {
      const list = map.get(note.sentenceHash);
      if (list) list.push(note);
      else map.set(note.sentenceHash, [note]);
    }
    return map;
  }, [paper.annotations.notes]);

  const sectionTitles = useMemo(
    () => new Map(paper.structure.sections.map((section) => [section.id, section.title])),
    [paper.structure.sections],
  );

  useEffect(() => {
    if (!scrollTarget) return;
    listRef.current
      ?.querySelector(`[data-card-for="${CSS.escape(scrollTarget.id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollTarget]);

  let lastSection: string | null | undefined;

  return (
    <div className="sidebar" ref={listRef}>
      {visibleSentences.length === 0 && <p className="pane-message">一致する文がありません。</p>}
      {visibleSentences.map((sentence) => {
        const heading = sentence.sectionId !== lastSection ? sectionTitles.get(sentence.sectionId ?? '') : undefined;
        lastSection = sentence.sectionId;
        return (
          <Fragment key={sentence.id}>
            {heading && <h2 className="sidebar-section">{heading}</h2>}
            <SentenceCard
              sentence={sentence}
              document={paper}
              notes={notesByHash.get(sentence.hash) ?? []}
              active={selectedId === sentence.id}
              onSelect={props.onSelect}
              onSaveTranslation={props.onSaveTranslation}
              onAddNote={props.onAddNote}
              onDeleteNote={props.onDeleteNote}
              onToggleSkip={props.onToggleSkip}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

interface CardProps {
  sentence: Sentence;
  document: PaperDocument;
  notes: Note[];
  active: boolean;
  onSelect: (sentenceId: string, origin: 'pdf' | 'sidebar') => void;
  onSaveTranslation: (hash: string, text: string) => Promise<boolean>;
  onAddNote: (hash: string, body: string) => Promise<boolean>;
  onDeleteNote: (noteId: string) => Promise<boolean>;
  onToggleSkip: (hash: string, skip: boolean) => Promise<boolean>;
}

function SentenceCard(props: CardProps): React.JSX.Element {
  const { sentence, document: paper, notes, active } = props;
  const translation = paper.annotations.translations[sentence.hash];
  const isSkipped = Boolean(paper.annotations.skipped?.[sentence.hash]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(translation?.text ?? '');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 編集中は SSE 由来の更新で下書きを潰さない。
    if (!editing) setDraft(translation?.text ?? '');
  }, [translation?.text, editing]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      if (await props.onSaveTranslation(sentence.hash, draft)) setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const select = (): void => props.onSelect(sentence.id, 'sidebar');

  return (
    <article
      data-card-for={sentence.id}
      className={`card${active ? ' is-active' : ''}${isSkipped ? ' is-skipped' : ''}`}
      // カードは「文を選ぶ」操作なので、マウスにもキーボードにも同じ入口を出す。
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={select}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select();
        }
      }}
    >
      {editing ? (
        <div className="card-editor" onClick={(event) => event.stopPropagation()}>
          <textarea
            value={draft}
            autoFocus
            rows={3}
            aria-label="訳文"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save();
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <div className="card-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <span className="hint">⌘/Ctrl + Enter で保存</span>
          </div>
        </div>
      ) : (
        <p
          className={`card-target${translation?.revisedByHuman ? ' is-human' : ''}${translation ? '' : ' is-empty'}`}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setEditing(true);
          }}
        >
          {translation?.text ?? (isSkipped ? '（訳さない）' : '（未訳）')}
        </p>
      )}

      <p className="card-source" lang="en">
        {sentence.text}
      </p>

      {notes.map((note) => (
        <p key={note.id} className="card-note">
          {note.body}
          <button
            type="button"
            className="note-delete"
            title="メモを削除"
            aria-label="メモを削除"
            onClick={(event) => {
              event.stopPropagation();
              void props.onDeleteNote(note.id);
            }}
          >
            ×
          </button>
        </p>
      ))}

      {noteOpen && (
        <div className="card-editor" onClick={(event) => event.stopPropagation()}>
          <textarea
            value={noteDraft}
            rows={2}
            autoFocus
            aria-label="メモ"
            placeholder="訳語の判断、原文の曖昧さ、他の論文との関係など"
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className="card-actions">
            <button
              type="button"
              disabled={busy || noteDraft.trim().length === 0}
              onClick={() => {
                setBusy(true);
                void props
                  .onAddNote(sentence.hash, noteDraft.trim())
                  .then((ok) => {
                    if (ok) {
                      setNoteDraft('');
                      setNoteOpen(false);
                    }
                  })
                  .finally(() => setBusy(false));
              }}
            >
              メモを追加
            </button>
            <button type="button" onClick={() => setNoteOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="card-toolbar" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => setEditing(true)}>
          訳を編集
        </button>
        <button type="button" onClick={() => setNoteOpen(true)}>
          メモ
        </button>
        <button
          type="button"
          title={isSkipped ? '訳す対象に戻す' : '訳す対象から外す（参考文献・数式など）'}
          onClick={() => void props.onToggleSkip(sentence.hash, !isSkipped)}
        >
          {isSkipped ? '訳す対象に戻す' : '訳さない'}
        </button>
        <span className="card-page">p.{sentence.page}</span>
      </div>
    </article>
  );
}

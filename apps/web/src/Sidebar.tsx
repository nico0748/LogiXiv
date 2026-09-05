import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note, PaperDocument, Sentence } from './api.ts';

/**
 * 1 文 = 1 カードのサイドバー。
 *
 * 訳は「クリックしたら編集できる」だけにしてある。編集モードの切り替えを
 * 明示的なボタンにすると、読みながら気になった 1 文を直す動作が重くなるため。
 * 保存すると revisedByHuman が立ち、以後 Claude の訳で上書きされなくなる。
 */

interface Props {
  document: PaperDocument;
  selectedId: string | null;
  filter: string;
  onSelect: (sentenceId: string) => void;
  onSaveTranslation: (hash: string, text: string) => Promise<void>;
  onAddNote: (hash: string, body: string) => Promise<void>;
  onDeleteNote: (noteId: string) => Promise<void>;
}

export function Sidebar(props: Props): React.JSX.Element {
  const { document: paper, selectedId, filter } = props;
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

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (needle.length === 0) return paper.structure.sentences;
    return paper.structure.sentences.filter((sentence) => {
      const haystack = [
        sentence.text,
        paper.annotations.translations[sentence.hash]?.text ?? '',
        ...(notesByHash.get(sentence.hash) ?? []).map((note) => note.body),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [needle, paper, notesByHash]);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector(`[data-card-for="${selectedId}"]`)?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
  }, [selectedId]);

  let lastSection: string | null | undefined;

  return (
    <div className="sidebar" ref={listRef}>
      {visible.length === 0 && <p className="pane-message">一致する文がありません。</p>}
      {visible.map((sentence) => {
        const heading = sentence.sectionId !== lastSection ? sectionTitles.get(sentence.sectionId ?? '') : undefined;
        lastSection = sentence.sectionId;
        return (
          <div key={sentence.id}>
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
            />
          </div>
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
  onSelect: (sentenceId: string) => void;
  onSaveTranslation: (hash: string, text: string) => Promise<void>;
  onAddNote: (hash: string, body: string) => Promise<void>;
  onDeleteNote: (noteId: string) => Promise<void>;
}

function SentenceCard(props: CardProps): React.JSX.Element {
  const { sentence, document: paper, notes, active } = props;
  const translation = paper.annotations.translations[sentence.hash];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(translation?.text ?? '');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(translation?.text ?? '');
  }, [translation?.text, editing]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await props.onSaveTranslation(sentence.hash, draft);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-card-for={sentence.id}
      className={`card${active ? ' is-active' : ''}`}
      onClick={() => props.onSelect(sentence.id)}
    >
      {editing ? (
        <div className="card-editor" onClick={(event) => event.stopPropagation()}>
          <textarea
            value={draft}
            autoFocus
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save();
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <div className="card-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>
              保存
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
          {translation?.text ?? '（未訳）'}
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
            placeholder="訳語の判断、原文の曖昧さ、他の論文との関係など"
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className="card-actions">
            <button
              type="button"
              disabled={noteDraft.trim().length === 0}
              onClick={() => {
                void props.onAddNote(sentence.hash, noteDraft.trim()).then(() => {
                  setNoteDraft('');
                  setNoteOpen(false);
                });
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
        <span className="card-page">p.{sentence.page}</span>
      </div>
    </article>
  );
}

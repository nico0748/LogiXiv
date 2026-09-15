import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { NonBodySentence, Note, PaperDocument, Sentence, Translation } from './api.ts';
// 差し込み位置の規則は core と共有する。ここ・書き出し・ビューアで並びが違うと、
// 同じ論文を 3 通りの順序で見せることになる。
import { placeNonBody } from '../../../packages/core/src/nonbody.ts';

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
 *
 * **カードは値で比べて memo する。**
 * この道具の中核は「j/k で 1 文ずつ読む」ことなのに、選択が動くたびに全カードを
 * 作り直していた（実測: 2750 行の論文で 1 打 141ms、130 行なら 12.6ms）。
 * さらに MCP の流し込み中は 300ms ごとのリロードでも全件が作り直され、
 * 10.3 秒の書き込みのあいだ longtask が 10.5 秒ぶん（最大 397ms）出ていた。
 *
 * 参照で比べても意味がない。リロードのたびに JSON から作り直すので、
 * 中身が同じでも `sentence` も `translation` も別物になる。だから
 * 「画面に出る値」だけを取り出して比べる（下の sameCard）。文書まるごとを
 * カードに渡していたのも同じ理由でやめた — 1 文の訳が届いただけで
 * 全カードの props が変わってしまう。
 */

/** メモが無い文に渡す配列。毎回 [] を作ると、その 1 点だけで比較が外れる。 */
const NO_NOTES: Note[] = [];

interface Props {
  document: PaperDocument;
  selectedId: string | null;
  filter: string;
  visibleSentences: Sentence[];
  /**
   * 絞り込みに一致した「本文として扱わなかった行」。絞り込んでいないときは全件。
   *
   * 検索から外していたので、画面に現に出ているカード（参考文献など）を
   * 検索が「一致する文がありません」と言い、さらに絞り込むとそのカード自体が
   * 消えて「なぜ右に無いのか」の説明まで失われていた。
   */
  visibleNonBody: NonBodySentence[];
  onSelect: (sentenceId: string, origin: 'pdf' | 'sidebar' | 'keyboard') => void;
  onSaveTranslation: (hash: string, text: string) => Promise<boolean>;
  onAddNote: (hash: string, body: string) => Promise<boolean>;
  onDeleteNote: (noteId: string) => Promise<boolean>;
  onToggleSkip: (hash: string, skip: boolean) => Promise<boolean>;
  onDeleteTranslation: (hash: string, alsoSkip: boolean) => Promise<boolean>;
  onMergeWithNext: (hashes: [string, string]) => Promise<boolean>;
  onSplit: (hash: string, offsets: number[]) => Promise<boolean>;
  scrollTarget: { id: string; token: number } | null;
}

export function Sidebar(props: Props): React.JSX.Element {
  const { document: paper, selectedId, visibleSentences, visibleNonBody, scrollTarget } = props;

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

  /**
   * 本文として扱わなかった行（参考文献・表・柱・著者行など）を、
   * 直前の本文の後ろに差し込むための索引。
   *
   * 落とすこと自体は正しい（参考文献を訳す必要はない）が、落としたことが
   * どこにも出ないと、左の PDF に見えているものが右に 1 行も無い状態になる。
   * はじめて使った人はそこで「まだ訳が来ていないのか、自分が見落としたのか」
   * を判断できず、しかもヘッダーは「26 / 27 文」と完了したように出る。
   *
   * どの文の後ろに置くかの規則は core と共有する（placeNonBody）。
   * 同じ本文が 2 回出る論文で「hash の最初の出現」を採ると、末尾の参考文献が
   * 序論の途中に出た。書き出し・ビューアにも同じ写しがあって同じようにずれていた。
   */
  const placement = useMemo(
    () => placeNonBody(paper.structure.sentences, paper.structure.nonBody),
    [paper.structure.nonBody, paper.structure.sentences],
  );

  /** いま出してよい本文の文（絞り込み結果）。並びは本文の並びのまま引く。 */
  const visibleSentenceIds = useMemo(
    () => new Set(visibleSentences.map((sentence) => sentence.id)),
    [visibleSentences],
  );
  /** いま出してよい本文以外の行。絞り込んでいないときは全件が入る。 */
  const visibleNonBodyIds = useMemo(() => new Set(visibleNonBody.map((item) => item.id)), [visibleNonBody]);

  /**
   * 区切りを直す操作の相手と、それが何か所に効くか。
   *
   * 相手は絞り込み後の並びではなく本文の並びで引く。検索中に見えている次の
   * カードと結合してしまうと、画面と結果が食い違う。
   * 件数を先に数えるのは、押す前に「何か所変わるか」を出すため。
   * 同じ本文が 15 か所ある論文で、押した後に「15 か所変えました」と言われても遅い。
   */
  const relations = useMemo(() => {
    const all = paper.structure.sentences;
    const nextById = new Map<string, Sentence>();
    const hashCounts = new Map<string, number>();
    const pairCounts = new Map<string, number>();
    // 2 回目以降の出現に印を付ける。訳は本文ごとに 1 つなので、
    // 一度も触っていないカードに訳が入っていることがある。何が起きたのか
    // 分からないまま「勝手に訳が出た」と読まれていた。
    const repeated = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      const sentence = all[i]!;
      hashCounts.set(sentence.hash, (hashCounts.get(sentence.hash) ?? 0) + 1);
      if (seen.has(sentence.hash)) repeated.add(sentence.id);
      else seen.add(sentence.hash);
      const next = all[i + 1];
      if (!next) continue;
      nextById.set(sentence.id, next);
      const key = `${sentence.hash}|${next.hash}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    return { nextById, hashCounts, pairCounts, repeated };
  }, [paper.structure.sentences]);

  /**
   * 選ばれた文のカードまでスクロールする。**着いたかどうかを見届ける。**
   *
   * カードは画面の外では組まれない（styles.css の content-visibility）ので、
   * 遠くへ飛ぶときの道中の高さは見積もりでしかない。飛んだ先で実寸に置き換わると
   * その差だけ行き先がずれ、PDF のマーカーから飛んだカードが画面の外に居座る。
   * 一度で当てようとせず、落ち着いたころに測り直して、ずれていたら合わせ直す。
   * 補正は一瞬で済ませる（また滑らせると、直したことが分かりにくい）。
   */
  useEffect(() => {
    if (!scrollTarget) return;
    const selector = `.sidebar [data-card-for="${CSS.escape(scrollTarget.id)}"]`;
    const first = window.document.querySelector(selector);
    if (!first) return;
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = (): void => {
      timer = null;
      const card = window.document.querySelector(selector);
      const sidebar = card?.closest('.sidebar');
      if (!card || !sidebar) return;
      const cardBox = card.getBoundingClientRect();
      const paneBox = sidebar.getBoundingClientRect();
      const off = (cardBox.top + cardBox.bottom) / 2 - (paneBox.top + paneBox.bottom) / 2;
      // 中央から半画面以上ずれていたら、まだ着いていない。
      if (Math.abs(off) > paneBox.height / 2 - cardBox.height) {
        card.scrollIntoView({ block: 'center' });
      }
      if (++attempts < 3) timer = setTimeout(check, 200);
    };
    timer = setTimeout(check, 400);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [scrollTarget]);

  const filtering = props.filter.trim().length > 0;

  if (visibleSentences.length === 0 && (!filtering || visibleNonBody.length === 0)) {
    // 「一致しない」と「そもそも文が無い」は原因も対処も違う。
    // スキャン PDF を開いた人に検索の話をしても仕方がない。
    return (
      <div className="sidebar">
        <p className="pane-message">
          {filtering
            ? '一致する文がありません。'
            : 'この PDF からは文を取り出せませんでした。画像だけのスキャン PDF は先に OCR を通してください。'}
        </p>
      </div>
    );
  }

  let lastSection: string | null | undefined;

  return (
    <div className="sidebar">
      {/* 絞り込み中は「何に当たったか」を先に言う。本文以外の行も出すので、
          訳が付かないカードが並ぶ理由がここで分かるようにしておく。 */}
      {filtering && (
        <p className="sidebar-filter-note">
          一致: 本文 {visibleSentences.length} 件
          {visibleNonBody.length > 0 && ` ／ 訳さない行 ${visibleNonBody.length} 件（参考文献・図表など）`}
        </p>
      )}

      {/* 本文より前にあるもの（表題・著者行）。絞り込み中は一致したものだけ出す。 */}
      {placement.head
        .filter((item) => visibleNonBodyIds.has(item.id))
        .map((item) => (
          <NonBodyCard key={item.id} item={item} matched={filtering} />
        ))}

      {/* 並びは**本文の並び**でたどる。絞り込みで本文が隠れても、一致した
          本文以外の行がもとの位置のまま出るようにするため。 */}
      {paper.structure.sentences.map((sentence) => {
        const nonBody = (placement.after.get(sentence.id) ?? []).filter((item) => visibleNonBodyIds.has(item.id));
        if (!visibleSentenceIds.has(sentence.id)) {
          if (nonBody.length === 0) return null;
          return (
            <Fragment key={sentence.id}>
              {nonBody.map((item) => (
                <NonBodyCard key={item.id} item={item} matched={filtering} />
              ))}
            </Fragment>
          );
        }
        const heading = sentence.sectionId !== lastSection ? sectionTitles.get(sentence.sectionId ?? '') : undefined;
        lastSection = sentence.sectionId;
        const next = relations.nextById.get(sentence.id) ?? null;
        return (
          <Fragment key={sentence.id}>
            {heading && <h2 className="sidebar-section">{heading}</h2>}
            <SentenceCard
              sentence={sentence}
              translation={paper.annotations.translations[sentence.hash]}
              skipped={Boolean(paper.annotations.skipped?.[sentence.hash])}
              notes={notesByHash.get(sentence.hash) ?? NO_NOTES}
              active={selectedId === sentence.id}
              onSelect={props.onSelect}
              onSaveTranslation={props.onSaveTranslation}
              onAddNote={props.onAddNote}
              onDeleteNote={props.onDeleteNote}
              onToggleSkip={props.onToggleSkip}
              onDeleteTranslation={props.onDeleteTranslation}
              next={next}
              mergeOccurrences={next ? (relations.pairCounts.get(`${sentence.hash}|${next.hash}`) ?? 1) : 0}
              splitOccurrences={relations.hashCounts.get(sentence.hash) ?? 1}
              repeat={relations.repeated.has(sentence.id)}
              onMergeWithNext={props.onMergeWithNext}
              onSplit={props.onSplit}
            />
            {nonBody.map((item) => (
              <NonBodyCard key={item.id} item={item} matched={filtering} />
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

/** 継ぎ目に挟まっていたものの呼び方。並べても長くならないよう 2 つまで。 */
function seamLabel(kinds: NonBodySentence['kind'][]): string {
  const names = kinds.map((kind) => KIND_LABELS[kind] ?? '行');
  if (names.length === 0) return '行';
  if (names.length <= 2) return names.join('と');
  return `${names.slice(0, 2).join('と')}など`;
}

const KIND_LABELS: Record<NonBodySentence['kind'], string> = {
  frontMatter: '表題・著者',
  runningHead: '柱',
  pageNumber: 'ページ番号',
  caption: '図表キャプション',
  reference: '参考文献',
  footnote: '脚注',
  formula: '数式',
  table: '表',
  other: '本文以外',
};

/**
 * 本文として扱わなかった行。訳の対象ではないので、操作は付けずに「在ること」だけ示す。
 * ここに本文が紛れ込んでいたら、それは解析の誤りなので、種類を出して気づけるようにする。
 *
 * 検索に当たって出ているときは印を付ける。訳が付かないカードなので、
 * 本文のヒットと同じ見た目で並ぶと「訳し忘れの一致」に見えてしまう。
 */
const NonBodyCard = memo(function NonBodyCard({
  item,
  matched,
}: {
  item: NonBodySentence;
  matched: boolean;
}): React.JSX.Element {
  return (
    <article className={`card is-nonbody${matched ? ' is-match' : ''}`} data-card-for={item.id}>
      <p className="card-nonbody-kind">
        {KIND_LABELS[item.kind]}（訳しません）
        {matched && <span className="card-nonbody-match">検索に一致</span>}
      </p>
      <p className="card-source" lang="en">
        {item.text}
      </p>
    </article>
  );
});

interface CardProps {
  sentence: Sentence;
  /** この文に付いている訳。無ければ undefined。文書ごと渡すと比較が効かない。 */
  translation: Translation | undefined;
  /** 「訳さない」に入っているか。 */
  skipped: boolean;
  notes: Note[];
  active: boolean;
  onSelect: (sentenceId: string, origin: 'pdf' | 'sidebar' | 'keyboard') => void;
  onSaveTranslation: (hash: string, text: string) => Promise<boolean>;
  onAddNote: (hash: string, body: string) => Promise<boolean>;
  onDeleteNote: (noteId: string) => Promise<boolean>;
  onToggleSkip: (hash: string, skip: boolean) => Promise<boolean>;
  /** 訳を消す。`alsoSkip` を立てると、消してそのまま「訳さない」に移す。 */
  onDeleteTranslation: (hash: string, alsoSkip: boolean) => Promise<boolean>;
  /** 本文の並びで次に来る文。最後の文では null。 */
  next: Sentence | null;
  /** 結合が何か所に効くか。 */
  mergeOccurrences: number;
  /** 分割が何か所に効くか。 */
  splitOccurrences: number;
  /** 同じ本文がこれより前にも出ているか。訳を共有していることの説明に使う。 */
  repeat: boolean;
  onMergeWithNext: (hashes: [string, string]) => Promise<boolean>;
  onSplit: (hash: string, offsets: number[]) => Promise<boolean>;
}

/** 語の切れ目。分割はここにしか置けない（単語の途中で切ると読めない断片ができる）。 */
function wordBoundaries(text: string): number[] {
  const offsets: number[] = [];
  const word = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = word.exec(text)) !== null) {
    if (match.index > 0) offsets.push(match.index);
  }
  return offsets;
}

function preview(text: string, length = 28): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

function tail(text: string, length = 20): string {
  return text.length <= length ? text : `…${text.slice(-length)}`;
}

function SentenceCardView(props: CardProps): React.JSX.Element {
  const { sentence, translation, notes, active } = props;
  const isSkipped = props.skipped;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(translation?.text ?? '');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 訳を消す前の確認。ダイアログを出さず、そのカードの中で訊く。 */
  const [confirming, setConfirming] = useState<'skip' | 'delete' | null>(null);
  /** 分割の切れ目を選んでいる最中か。 */
  const [choosingSplit, setChoosingSplit] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  const boundaries = useMemo(() => wordBoundaries(sentence.text), [sentence.text]);

  useEffect(() => {
    // 編集中は SSE 由来の更新で下書きを潰さない。
    if (!editing) setDraft(translation?.text ?? '');
  }, [translation?.text, editing]);

  useEffect(() => {
    // 本文が変わったら選び直し。前の文の位置を新しい文に当ててはいけない。
    setChoosingSplit(false);
  }, [sentence.hash]);

  useEffect(() => {
    // 開いたら最初の切れ目に焦点を移す。切れ目は「分割…」ボタンより前にあるので、
    // そのまま Tab を押すと次のカードへ飛んでしまい、キーボードでは辿り着けない。
    if (choosingSplit) splitRef.current?.querySelector('button')?.focus();
  }, [choosingSplit]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      if (await props.onSaveTranslation(sentence.hash, draft)) setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const select = (): void => props.onSelect(sentence.id, 'sidebar');

  const canMerge = props.next !== null;

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

      {choosingSplit ? (
        /**
         * 分割の切れ目を選ぶ。語と語の間に実体のあるボタンを置く。
         *
         * 以前は原文をクリックしたキャレット位置で切っていたが、(a) どこで切れるかが
         * 画面に出ない、(b) 文を選ぶだけのクリックでも切る準備が整ってしまう、
         * (c) キーボードだけでは一生たどり着けない、(d) 単語の途中で切れる、
         * と 4 つ別々の壊れ方をした。押せる点として出せば全部消える。
         */
        <div
          className="card-split"
          ref={splitRef}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') setChoosingSplit(false);
          }}
        >
          <p className="card-source is-splitting" lang="en">
            {boundaries.map((offset, index) => (
              <Fragment key={offset}>
                <span>{sentence.text.slice(index === 0 ? 0 : boundaries[index - 1]!, offset)}</span>
                <button
                  type="button"
                  className="split-point"
                  disabled={busy}
                  title={`ここで分割: 「${tail(sentence.text.slice(0, offset).trim())}」／「${preview(
                    sentence.text.slice(offset).trim(),
                  )}」`}
                  aria-label={`ここで分割。前半の終わりは ${tail(
                    sentence.text.slice(0, offset).trim(),
                  )}、後半の始まりは ${preview(sentence.text.slice(offset).trim())}`}
                  onClick={() => {
                    setBusy(true);
                    void props
                      .onSplit(sentence.hash, [offset])
                      .then((ok) => {
                        if (ok) setChoosingSplit(false);
                      })
                      .finally(() => setBusy(false));
                  }}
                />
              </Fragment>
            ))}
            <span>{sentence.text.slice(boundaries[boundaries.length - 1] ?? 0)}</span>
          </p>
          <div className="card-actions">
            <span className="hint">
              切りたい位置の縦線を押してください
              {props.splitOccurrences > 1 && `（同じ本文の ${props.splitOccurrences} か所すべてに効きます）`}
            </span>
            <button type="button" disabled={busy} onClick={() => setChoosingSplit(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <p className="card-source" lang="en">
          {sentence.text}
        </p>
      )}

      {/* 文書単位のバッジでは足りない。52 文のうち 46 文が正しいとき、
          読み手が知る必要があるのは「どの 6 文か」なので、その文の中で言う。
          ここが無いと、記号が落ちて**文法の通る英文**になった文を、
          Claude がもっともらしい日本語に訳し、読者には「そう書いてある」
          としか見えない（定理の不等式から係数が消えた例が実際にあった）。 */}
      {sentence.seam && (
        <div className="card-seam">
          <p>
            この文には、本文として取り出せなかった{seamLabel(sentence.seam.kinds)}が挟まっています。
            記号や語が抜けているおそれがあるので、訳す前に PDF を確かめてください。
          </p>
          {/* 抜けた中身をその場に出す。補題の本体が落ちていることがあり、
              中身が分かれば「飛ばす」以外の手（補って訳す）が取れる。 */}
          {sentence.seam.texts && sentence.seam.texts.length > 0 && (
            <p className="card-seam-text" lang="en">
              抜けたのはここ: {sentence.seam.texts.join(' / ')}
            </p>
          )}
        </div>
      )}

      {props.repeat && (
        <p className="card-repeat">同じ本文が前にも出ています（訳は共通）</p>
      )}

      {notes.map((note) => (
        <p key={note.id} className="card-note">
          {note.body}
          {/* 誰のメモかを出す。メモは衝突しても消さない規則で積み上がるので、
              Claude の「自信が無い」と同僚の断定と自分の書きかけが混ざる。
              誰が言ったかが判断材料そのもの。 */}
          {note.author && <span className="card-note-author">{note.author}</span>}
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

      {confirming && (
        <div className="card-confirm" onClick={(event) => event.stopPropagation()}>
          <span>
            {confirming === 'skip'
              ? 'この訳を消して、訳す対象から外します。訳は元に戻せません。'
              : 'この訳を消して、未訳に戻します。元に戻せません。'}
            {props.splitOccurrences > 1 && `（同じ本文の ${props.splitOccurrences} か所すべてに効きます）`}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void props
                .onDeleteTranslation(sentence.hash, confirming === 'skip')
                .then(() => setConfirming(null))
                .finally(() => setBusy(false));
            }}
          >
            {confirming === 'skip' ? '消して外す' : '消す'}
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            やめる
          </button>
        </div>
      )}

      <div className="card-toolbar" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => setEditing(true)}>
          訳を編集
        </button>
        <button type="button" onClick={() => setNoteOpen(true)}>
          メモ
        </button>
        {translation ? (
          /* 既訳の文は skip できない（未訳の集計が減らないので、記録しても嘘になる）。
             押しても無反応だった頃、壊れているのか自分が間違えたのかも分からなかった。
             訳を消すことが前提だと分かる文言にして、取り返しのつかない操作なので
             その場で一度確かめる。 */
          <button
            type="button"
            title="この文の訳を消して、訳す対象から外します"
            onClick={() => setConfirming(confirming === 'skip' ? null : 'skip')}
          >
            訳を消して外す
          </button>
        ) : (
          <button
            type="button"
            title={isSkipped ? '訳す対象に戻す' : '訳す対象から外す（参考文献・数式など）'}
            onClick={() => void props.onToggleSkip(sentence.hash, !isSkipped)}
          >
            {isSkipped ? '訳す対象に戻す' : '訳さない'}
          </button>
        )}
        {translation && (
          <button
            type="button"
            title="この文の訳を消して、未訳に戻します"
            onClick={() => setConfirming(confirming === 'delete' ? null : 'delete')}
          >
            訳を消す
          </button>
        )}
        <button
          type="button"
          // disabled にすると Tab で飛ばされ、なぜ押せないのかを知る手段が無くなる。
          aria-disabled={!canMerge}
          title={
            canMerge
              ? `次の文と 1 つにします: 「${preview(props.next!.text, 40)}」${
                  props.mergeOccurrences > 1 ? `（同じ並びの ${props.mergeOccurrences} か所すべて）` : ''
                }`
              : 'この文が最後なので、結合する相手がいません'
          }
          onClick={() => {
            if (!canMerge || busy) return;
            setBusy(true);
            void props.onMergeWithNext([sentence.hash, props.next!.hash]).finally(() => setBusy(false));
          }}
        >
          次と結合{canMerge && props.mergeOccurrences > 1 ? `（${props.mergeOccurrences}か所）` : ''}
        </button>
        <button
          type="button"
          aria-disabled={boundaries.length === 0}
          aria-expanded={choosingSplit}
          title={
            boundaries.length === 0
              ? '語がひとつしかないので分割できません'
              : '原文の切れ目を選んで 2 文に分けます'
          }
          onClick={() => {
            if (boundaries.length === 0) return;
            setChoosingSplit((open) => !open);
          }}
        >
          分割…{props.splitOccurrences > 1 ? `（${props.splitOccurrences}か所）` : ''}
        </button>
        <span className="card-page">p.{sentence.page}</span>
      </div>
    </article>
  );
}

/**
 * カードを作り直すべきかを、参照ではなく**画面に出る値**で決める。
 *
 * リロードのたびに JSON から作り直されるので、同じ内容でも `sentence` や
 * `translation` は必ず別のオブジェクトになる。既定の浅い比較では 1 件も
 * 一致せず、memo が空振りする。
 *
 * メモは件数と id だけを見る（本文を全部たどると、比較のほうが描き直しより高くつく）。
 * 本文が変われば id か updatedAt が動くので、これで取りこぼさない。
 */
function sameCard(a: CardProps, b: CardProps): boolean {
  if (a.active !== b.active || a.skipped !== b.skipped || a.repeat !== b.repeat) return false;
  if (a.mergeOccurrences !== b.mergeOccurrences || a.splitOccurrences !== b.splitOccurrences) return false;
  if (a.sentence.id !== b.sentence.id) return false;
  if (a.sentence.hash !== b.sentence.hash) return false;
  if (a.sentence.text !== b.sentence.text) return false;
  if (a.sentence.page !== b.sentence.page) return false;
  if (a.next?.hash !== b.next?.hash) return false;
  if (a.next?.text !== b.next?.text) return false;
  if (a.translation?.text !== b.translation?.text) return false;
  if (a.translation?.revisedByHuman !== b.translation?.revisedByHuman) return false;
  if (a.notes.length !== b.notes.length) return false;
  for (let i = 0; i < a.notes.length; i++) {
    const before = a.notes[i]!;
    const after = b.notes[i]!;
    if (before.id !== after.id || before.body !== after.body || before.author !== after.author) return false;
  }
  return (
    a.onSelect === b.onSelect &&
    a.onSaveTranslation === b.onSaveTranslation &&
    a.onAddNote === b.onAddNote &&
    a.onDeleteNote === b.onDeleteNote &&
    a.onToggleSkip === b.onToggleSkip &&
    a.onDeleteTranslation === b.onDeleteTranslation &&
    a.onMergeWithNext === b.onMergeWithNext &&
    a.onSplit === b.onSplit
  );
}

const SentenceCard = memo(SentenceCardView, sameCard);

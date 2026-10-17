// 開いている論文の発表スライドとマークアップ。中央の画面（SlidesView）と右サイドバー（MarkupPanel）で共有する。
// 保存は注釈と同じく、保存先にあると分かっている状態との差分（操作）で送る。AI エージェントが同時に足したものは消えない。
//
// 読み直しと保存が重なっても画面の変更を失わないように、次の 3 つを守る。
// - 保存は 1 つずつ順に送る（inflight）。送る内容は送ると決めた時点で固める（論文を替えても、前の論文に正しく届く）
// - 保存か取り込みが終わるたびに世代（gen）を進める。読み直しの途中で世代が変わったら、その結果は古いので読み直す
// - 読み直しには番号（seq）を振り、最後に始めたものだけを画面に当てる

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import { type SlideDeck, type SlideMarkup, applyMarkupOps, diffMarkups, restoreMarkup } from "../../lib/slides.ts";

export type SlidesState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ready"; deck: SlideDeck; pdf: ArrayBuffer }
  | { kind: "error"; message: string };

/** 最後に消したグループ。元に戻すまで（か、知らせが消えるまで）持つ */
export interface RemovedMarkup {
  markup: SlideMarkup;
  /** 消す前の並びの位置 */
  at: number;
  /** 同じグループを続けて消し戻ししたときも、知らせを出し直すための番号 */
  n: number;
}

export interface Slides {
  state: SlidesState;
  /** 取り込み中のファイル名 */
  importing: string | null;
  importFile(f: File): Promise<void>;
  update(fn: (d: SlideDeck) => SlideDeck): void;
  /** グループを消す。論文側のリンク（ペア先）はグループの中にあるので、一緒に消える */
  remove(id: string): SlideMarkup | null;
  lastRemoved: RemovedMarkup | null;
  /** 最後に消したグループを、同じ ID・番号・リンクのまま戻す。戻したグループを返す */
  restore(): SlideMarkup | null;
  /** 元に戻す知らせを閉じる */
  dismissRemoved(): void;
}

type SaveState = "saving" | "saved" | { error: string };

export function useSlides(
  backend: Backend,
  paperId: string | null,
  opts: { active: boolean; onNote: (md: string) => void; onSave: (s: SaveState) => void },
): Slides {
  const [state, setState] = useState<SlidesState>({ kind: "loading" });
  const [importing, setImporting] = useState<string | null>(null);
  const deckRef = useRef<SlideDeck | null>(null);
  const baseRef = useRef<SlideDeck | null>(null);
  const pdfRef = useRef<ArrayBuffer | null>(null);
  const paperRef = useRef(paperId);
  paperRef.current = paperId;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const timer = useRef(0);
  /** 保存を待っている論文。null なら待っている変更は無い */
  const dirtyFor = useRef<string | null>(null);
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const gen = useRef(0);
  const seq = useRef(0);
  const importingRef = useRef(false);
  const [lastRemoved, setLastRemoved] = useState<RemovedMarkup | null>(null);
  const removedRef = useRef<RemovedMarkup | null>(null);
  /** 元に戻したグループの ID。保存するときに「戻す」操作にして、消した番号のまま戻す（論文を替えたら空にする） */
  const restored = useRef(new Set<string>());

  const show = (deck: SlideDeck) => {
    deckRef.current = deck;
    if (pdfRef.current) setState({ kind: "ready", deck, pdf: pdfRef.current });
  };

  /** 待っている変更をすぐに送る。終わるまで待てる */
  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    const id = dirtyFor.current;
    const sent = deckRef.current;
    const base = baseRef.current;
    dirtyFor.current = null;
    if (!id || !sent || !base) return inflight.current;
    const job = async () => {
      // 操作は何度当てても同じ結果になる形なので、前の保存と重なっていても壊れない
      const ops = diffMarkups(base, sent, restored.current);
      if (!ops.length) return optsRef.current.onSave("saved");
      try {
        const r = await backend.changeMarkups(id, ops);
        gen.current++;
        optsRef.current.onSave("saved");
        if (id !== paperRef.current || !deckRef.current) return;
        optsRef.current.onNote(r.note);
        baseRef.current = r.deck;
        // 送ったあとに画面で変えた分は、保存先の最新の上に重ねる
        show(applyMarkupOps(r.deck, diffMarkups(sent, deckRef.current, restored.current)));
      } catch (e) {
        optsRef.current.onSave({ error: e instanceof Error ? e.message : String(e) });
      }
    };
    inflight.current = inflight.current.then(job);
    return inflight.current;
  }, [backend]);

  const load = useCallback(
    async (id: string, forcePdf: boolean): Promise<void> => {
      const mySeq = ++seq.current;
      const myGen = gen.current;
      const deck = await backend.loadSlides(id);
      if (id !== paperRef.current || mySeq !== seq.current) return;
      // 読んでいる間に自分の保存が終わった。読んだ内容は古いので読み直す
      if (myGen !== gen.current) return load(id, forcePdf);
      if (!deck) {
        deckRef.current = baseRef.current = pdfRef.current = null;
        setState({ kind: "none" });
        return;
      }
      // スライドそのものが替わったときだけ PDF を読み直す（マークアップの変更では描き直さない）
      if (forcePdf || !pdfRef.current || deck.importedAt !== baseRef.current?.importedAt) {
        const pdf = await backend.loadSlidesPdf(id);
        if (id !== paperRef.current || mySeq !== seq.current) return;
        if (myGen !== gen.current) return load(id, forcePdf);
        pdfRef.current = pdf;
      }
      // まだ送っていない画面の変更は、読み直した上に重ねる
      const mine = deckRef.current && baseRef.current ? diffMarkups(baseRef.current, deckRef.current, restored.current) : [];
      baseRef.current = deck;
      show(applyMarkupOps(deck, mine));
    },
    [backend],
  );

  // スライドの画面を初めて開いたときに読む。論文を替えたら読み直す
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!paperId || !opts.active || loadedFor.current === paperId) return;
    // 前の論文の保存待ちは、状態を空にする前に送る
    void flush();
    loadedFor.current = paperId;
    deckRef.current = baseRef.current = pdfRef.current = null;
    restored.current = new Set();
    removedRef.current = null;
    setLastRemoved(null);
    setState({ kind: "loading" });
    load(paperId, true).catch((e: unknown) => {
      if (paperId === paperRef.current) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
  }, [paperId, opts.active, load, flush]);
  useEffect(() => {
    if (paperId !== loadedFor.current) loadedFor.current = null;
  }, [paperId]);

  // MCP サーバーなど、別の書き手の変更を映す
  useEffect(
    () =>
      backend.subscribe((e) => {
        if (e.kind !== "slides" || !e.paper || e.paper !== paperRef.current || loadedFor.current !== e.paper) return;
        void load(e.paper, false).catch(() => undefined);
      }),
    [backend, load],
  );

  const update = useCallback(
    (fn: (d: SlideDeck) => SlideDeck) => {
      const id = paperRef.current;
      if (!id || !deckRef.current) return;
      show(fn(deckRef.current));
      dirtyFor.current = id;
      optsRef.current.onSave("saving");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 400);
    },
    [flush],
  );

  const remove = useCallback(
    (id: string) => {
      const deck = deckRef.current;
      const at = deck?.markups.findIndex((m) => m.id === id) ?? -1;
      if (!deck || at < 0) return null;
      const markup = deck.markups[at];
      update((d) => ({ ...d, markups: d.markups.filter((m) => m.id !== id) }));
      const r = { markup, at, n: (removedRef.current?.n ?? 0) + 1 };
      removedRef.current = r;
      setLastRemoved(r);
      return markup;
    },
    [update],
  );

  const restore = useCallback(() => {
    const r = removedRef.current;
    removedRef.current = null;
    setLastRemoved(null);
    if (!r || !deckRef.current) return null;
    restored.current.add(r.markup.id);
    update((d) => restoreMarkup(d, r.markup, r.at));
    return r.markup;
  }, [update]);

  const dismissRemoved = useCallback(() => {
    removedRef.current = null;
    setLastRemoved(null);
  }, []);

  const importFile = useCallback(
    async (f: File) => {
      const id = paperRef.current;
      if (!id || importingRef.current) return;
      importingRef.current = true;
      setImporting(f.name);
      try {
        // 取り込みより前の編集は先に保存する（取り込みの結果で上書きしないように）
        await flush();
        await backend.importSlides(id, f.name, await f.arrayBuffer());
        gen.current++;
        if (id === paperRef.current) await load(id, true);
      } finally {
        importingRef.current = false;
        setImporting(null);
      }
    },
    [backend, flush, load],
  );

  return { state, importing, importFile, update, remove, lastRemoved, restore, dismissRemoved };
}

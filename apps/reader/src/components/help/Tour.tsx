// 初めて開いたときの画面の案内（ツアー）。対象の要素の周りを明るく残し、横に吹き出しを出す。
// ← → で前後、Esc で「あとで」。手順と始める条件は src/lib/tour.ts。
// 手順によって左右のサイドバーを開き、終えたら始める前の開き方に戻す。
import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import sampleUrl from "../../demo/sample.pdf?url";
import {
  type Box,
  TOUR_CLOSED,
  TOUR_KEY,
  TOUR_LATER_KEY,
  type AppMode,
  isTourDisabled,
  placePopover,
  readRecord,
  shouldAutoStart,
  tourReducer,
  tourSteps,
} from "../../lib/tour.ts";
import { isTyping, markChangesSeen } from "./useHelpState.ts";
import "./help.css";

export interface TourLayout {
  left: boolean;
  right: boolean;
}

interface Props {
  /** 動かし方。手順と言い方を合わせる */
  mode: AppMode;
  /** 画面の準備ができ、ほかの画面を重ねていないとき true。自動で始めるのはこのときだけ */
  ready: boolean;
  /** 値が変わるたびに最初から始める（ヘルプの「もう一度見る」） */
  restart: number;
  /** 論文があるか。無ければサンプルの論文を勧める */
  hasPapers: boolean;
  /** PDF を取り込む（サンプルの論文に使う） */
  onImport: (files: File[]) => Promise<void>;
  layout: TourLayout;
  setLayout: (l: Partial<TourLayout>) => void;
}

// localStorage / sessionStorage は、参照するだけで例外になる環境がある（保存を禁じた設定など）。取り出しも try の中で行う
const store = {
  get: (s: () => Storage, k: string) => {
    try {
      return s().getItem(k);
    } catch {
      return null;
    }
  },
  set: (s: () => Storage, k: string, v: string) => {
    try {
      s().setItem(k, v);
    } catch {
      // 覚えられなくても、案内は閉じられる
    }
  },
};
const local = () => localStorage;
const session = () => sessionStorage;

const PAD = 6;

export function Tour({ mode, ready, restart, hasPapers, onImport, layout, setLayout }: Props) {
  const steps = useMemo(() => tourSteps(mode), [mode]);
  const [state, dispatch] = useReducer((s: typeof TOUR_CLOSED, a: Parameters<typeof tourReducer>[1] & { total: number }) => tourReducer(s, a, a.total), TOUR_CLOSED);
  const go = useCallback((a: Parameters<typeof tourReducer>[1]) => dispatch({ ...a, total: steps.length }), [steps.length]);
  const step = state.open ? steps[state.index] : null;
  const [rect, setRect] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: string } | null>(null);
  const [importing, setImporting] = useState<"idle" | "busy" | "done" | "error">("idle");
  const popRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  /** 始める前のサイドバーの開き方 */
  const before = useRef<TourLayout | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // 初めて開いたときだけ、少し待ってから自動で始める（配置の読み込みとサイドバーの動きが落ち着くまで）
  const tried = useRef(false);
  useEffect(() => {
    if (!ready || tried.current) return;
    const env = {
      record: readRecord(store.get(local, TOUR_KEY)),
      later: store.get(session, TOUR_LATER_KEY) === "1",
      disabled: isTourDisabled(location.search, (window as unknown as { __PAPERLENS_NO_TOUR?: unknown }).__PAPERLENS_NO_TOUR),
    };
    if (!shouldAutoStart(env)) return;
    // 待つ間にほかの画面を開いたら取りやめ、閉じたあとにもう一度待つ
    const t = window.setTimeout(() => {
      tried.current = true;
      go({ type: "start" });
    }, 600);
    return () => window.clearTimeout(t);
  }, [ready, go]);

  useEffect(() => {
    if (restart) go({ type: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restart]);

  // 開いたときの配置を覚え、手順ごとに必要なサイドバーだけ開く。閉じたら元に戻す
  useEffect(() => {
    if (!state.open) {
      if (before.current) setLayout(before.current);
      before.current = null;
      return;
    }
    if (!before.current) before.current = { ...layoutRef.current };
    const base = before.current;
    const want = steps[state.index]?.open;
    // 狭い画面ではサイドバーが中央に重なるので、開くのは片方だけにする
    const narrow = window.innerWidth <= 900;
    setLayout({
      left: want === "left" || (base.left && !(narrow && (want === "right" || want === "none"))),
      right: want === "right" || (base.right && !(narrow && (want === "left" || want === "none"))),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.index]);

  // 手順にタブの指定があれば、その間だけそのタブを選ぶ。離れたら元のタブを押し直す
  useEffect(() => {
    const sel = step?.tab;
    if (!sel) return;
    const prev = document.querySelector<HTMLElement>("aside.sidebar.right [role='tab'][aria-selected='true']");
    // サイドバーを開いた直後はタブがまだ無いことがあるので、少し待つ
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.getAttribute("aria-selected") !== "true") el.click();
    }, 50);
    return () => {
      window.clearTimeout(t);
      const back = prev?.id ? document.getElementById(prev.id) : null;
      if (back && back.getAttribute("aria-selected") !== "true") back.click();
    };
  }, [step]);

  // 対象の位置を毎フレーム確かめる（サイドバーの開閉の動きや、窓の大きさの変化に付いていく）
  useLayoutEffect(() => {
    if (!step) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const el = step.targets.map((s) => document.querySelector<HTMLElement>(s)).find((e) => e && e.getClientRects().length > 0 && !e.closest("[aria-hidden='true']"));
      const r = el?.getBoundingClientRect();
      const view = { width: window.innerWidth, height: window.innerHeight };
      // 窓の中に収めた枠（端に接する要素でも強調の線が見えるように 2px 内側に寄せる）
      let box: Box | null = null;
      if (r && r.width > 0 && r.height > 0) {
        const l = Math.max(2, r.left - PAD);
        const t = Math.max(2, r.top - PAD);
        const rr = Math.min(view.width - 2, r.right + PAD);
        const b = Math.min(view.height - 2, r.bottom + PAD);
        if (rr > l && b > t) box = { left: l, top: t, width: rr - l, height: b - t };
      }
      const pop = popRef.current;
      const size = pop ? { width: pop.offsetWidth, height: pop.offsetHeight } : { width: 340, height: 220 };
      const key = JSON.stringify([box, size, view]);
      if (key !== last) {
        last = key;
        setRect(box);
        setPos(placePopover(box, size, view));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  // 手順が替わったら「次へ」にフォーカスする。閉じたら、開く前にフォーカスしていた所へ戻す
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (step) nextRef.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (state.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      return;
    }
    returnFocus.current?.focus?.({ preventScroll: true });
    returnFocus.current = null;
  }, [state.open]);

  const finish = useCallback(() => {
    store.set(local, TOUR_KEY, "done");
    // 初めての人に、それまでの更新情報の印は出さない
    markChangesSeen();
    go({ type: "finish" });
  }, [go]);
  const later = useCallback(() => {
    store.set(session, TOUR_LATER_KEY, "1");
    go({ type: "later" });
  }, [go]);
  const last = state.index === steps.length - 1;
  const next = useCallback(() => (last ? finish() : go({ type: "next" })), [last, finish, go]);

  // 開いている間のキー操作。← → Esc で動かし、Tab は吹き出しの中だけを回る。
  // ほかの画面のキー操作（Esc で重ねた画面を閉じる、j/k、スライドの r/v/Delete など）には渡さない
  useEffect(() => {
    if (!state.open) return;
    const on = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      const pop = popRef.current;
      if (e.key === "Tab" && pop) {
        const items = [...pop.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input, [tabindex]:not([tabindex='-1'])")];
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const j = i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
        e.preventDefault();
        items[j].focus();
        return;
      }
      // 入力欄に打っている文字は横取りしない
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") go({ type: "prev" });
      else if (e.key === "Escape") later();
      else if (!pop?.contains(e.target as Node)) e.preventDefault();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [state.open, next, later, go]);

  const importSample = async () => {
    setImporting("busy");
    try {
      const blob = await (await fetch(sampleUrl)).blob();
      await onImport([new File([blob], "sparse-window-attention.pdf", { type: "application/pdf" })]);
      setImporting("done");
    } catch {
      setImporting("error");
    }
  };

  if (!step) return null;
  const titleId = `tour-title-${step.id}`;
  return (
    <div className="tour" data-step={step.id}>
      {/* 対象の外を暗くし、押しても下の画面に届かないようにする */}
      <div className="tour-blocker" onMouseDown={(e) => e.preventDefault()} />
      {rect ? (
        <>
          {/* 対象の上下左右の 4 枚で暗くする（大きな影で暗くすると、窓の端で塗り残しが出るため） */}
          <div className="tour-dim" style={{ left: 0, top: 0, right: 0, height: rect.top }} aria-hidden="true" />
          <div className="tour-dim" style={{ left: 0, top: rect.top + rect.height, right: 0, bottom: 0 }} aria-hidden="true" />
          <div className="tour-dim" style={{ left: 0, top: rect.top, width: rect.left, height: rect.height }} aria-hidden="true" />
          <div className="tour-dim" style={{ left: rect.left + rect.width, top: rect.top, right: 0, height: rect.height }} aria-hidden="true" />
          <div className="tour-spot" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-hidden="true" />
        </>
      ) : (
        <div className="tour-dim" style={{ inset: 0 }} aria-hidden="true" />
      )}
      <div
        ref={popRef}
        className={`tour-pop is-${pos?.placement ?? "center"}`}
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-body`}
      >
        <div className="tour-pop-head">
          <span className="tour-count">{state.index + 1} / {steps.length}</span>
          <button type="button" className="clickable-icon tour-close" aria-label="あとで（Esc）" title="あとで（Esc）" onClick={later}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <h2 id={titleId} className="tour-title">{step.title}</h2>
        <div id={`${titleId}-body`} className="tour-body">
          {step.body.map((t) => <p key={t}>{t}</p>)}
        </div>
        {step.sample && (!hasPapers || importing === "done") && (
          <div className="tour-sample">
            {importing === "done" ? (
              <p role="status">サンプルの論文を取り込みました。案内のあとで読んでみてください。</p>
            ) : (
              <>
                <p>論文がまだありません。お試し用の論文で試せます。</p>
                <button type="button" className="btn tonal sm" disabled={importing === "busy"} onClick={() => void importSample()}>
                  {importing === "busy" ? "取り込んでいます…" : "サンプルの論文を取り込む"}
                </button>
                {importing === "error" && <p className="err-msg" role="alert">取り込めませんでした。あとで論文一覧から PDF を追加してください。</p>}
              </>
            )}
          </div>
        )}
        <div className="tour-dots" aria-hidden="true">
          {steps.map((s, i) => <span key={s.id} className={i === state.index ? "is-on" : undefined} />)}
        </div>
        <div className="tour-actions">
          <button type="button" className="btn text sm" onClick={finish}>スキップ</button>
          <button type="button" className="btn text sm" onClick={later}>あとで</button>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={state.index === 0} onClick={() => go({ type: "prev" })}>戻る</button>
          <button ref={nextRef} type="button" className="btn primary sm" onClick={next}>{last ? "使いはじめる" : "次へ"}</button>
        </div>
        <p className="tour-keys" aria-hidden="true"><kbd>←</kbd> <kbd>→</kbd> で移動、<kbd>Esc</kbd> であとで</p>
      </div>
    </div>
  );
}

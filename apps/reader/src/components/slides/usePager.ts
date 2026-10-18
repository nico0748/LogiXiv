// スライド・論文・補足情報を横に並べ、二面ずつ見せる横のページめくり。
//
//   ┌──────── 見える幅 V ────────┐
//   │ スライド │間│ 論文          │ 補足情報     │   ← 左端（scrollLeft = 0）
//               └──────── V ────────┘
//                  │ 論文          │ 補足情報     │   ← 右端（scrollLeft = スライド + 間）
//
// 論文の幅はどちらでも変わらない。トラックパッドの横スワイプや Shift+ホイールでも動かせるよう、本物の横スクロールにする。
// 今の面はスクロールの位置（近い方の止まる位置）から決めるので、スワイプしてもタブが追いつく。

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export type SlidesSide = "slides" | "info";

/** スライドと論文の間（幅を変えるつまみ）の幅 */
export const GUTTER = 56;
const KEY = "paperlens.slides.side";

const load = (): SlidesSide => {
  try {
    return localStorage.getItem(KEY) === "info" ? "info" : "slides";
  } catch {
    return "slides";
  }
};
const save = (s: SlidesSide) => {
  try {
    localStorage.setItem(KEY, s);
  } catch {
    // 保存できない（プライベートモードなど）ときは、覚えないだけにする
  }
};
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface Pager {
  /** 見える幅（V） */
  width: number;
  /** スライドの面の幅（px）。三面にしないときや測る前は 0 */
  slidesW: number;
  /** 右端（補足情報の側）の scrollLeft */
  offset: number;
  side: SlidesSide;
  /** スライドの面がすっかり見えなくなっている */
  slidesOff: boolean;
  /** 補足情報の面がすっかり見えなくなっている */
  infoOff: boolean;
  go: (s: SlidesSide) => void;
}

/**
 * @param ref 横にスクロールする枠（.sv-split）
 * @param enabled 三面にするか（補足情報が無いときは false。二分割のまま動かさない）
 * @param ratio スライドと論文の幅の割合（スライドの側）
 * @param onScroll 横に動いたとき（線を測り直すため）
 */
export function usePager(ref: RefObject<HTMLDivElement | null>, enabled: boolean, ratio: number, onScroll: () => void): Pager {
  const [width, setWidth] = useState(0);
  const [side, setSide] = useState<SlidesSide>(load);
  const [slidesOff, setSlidesOff] = useState(false);
  const [infoOff, setInfoOff] = useState(true);
  const slidesW = enabled && width ? ratio * (width - GUTTER) : 0;
  const offset = enabled && width ? slidesW + GUTTER : 0;

  const sideRef = useRef(side);
  sideRef.current = side;
  const geo = useRef({ width, slidesW, offset });
  geo.current = { width, slidesW, offset };
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  /** プログラムで動かしている間の行き先。着くまでは途中の位置でタブを変えない */
  const pending = useRef<number | null>(null);
  const pendingTimer = useRef(0);

  const choose = useCallback((s: SlidesSide) => {
    if (sideRef.current === s) return;
    sideRef.current = s;
    setSide(s);
    save(s);
  }, []);

  const visibility = useCallback((x: number) => {
    const { slidesW: w, offset: o } = geo.current;
    setSlidesOff(o > 0 && x >= w - 0.5);
    setInfoOff(o <= 0 || x <= 0.5);
  }, []);

  // 幅を測る
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    setWidth(el.clientWidth);
    // 測った幅はすぐ描き直す（下の位置合わせまで同じフレームで済ませ、選んでいる面が一瞬ずれて見えないように）
    const ro = new ResizeObserver(() => flushSync(() => setWidth(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);

  // 幅や割合が変わっても、選んでいる面に留まる（滑らかには動かさない）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const x = enabled && sideRef.current === "info" ? offset : 0;
    pending.current = null;
    el.scrollLeft = x;
    visibility(x);
    // 位置が同じでスクロールの知らせが来ないときも、線を測り直す
    onScrollRef.current();
  }, [ref, enabled, offset, visibility]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const derive = (x: number) => {
      const { width: w, offset: o } = geo.current;
      // 枠の幅が変わったばかり（全画面に入る・出るなど）で、まだ測り直していないときは決めない。
      // 中身より先に枠が広がると位置が詰められて動くが、それは選び直したのではない（測り直したあとで位置を戻す）
      if (o <= 0 || Math.abs(el.clientWidth - w) > 0.5) return;
      choose(x > o / 2 ? "info" : "slides");
    };
    const scroll = () => {
      const x = el.scrollLeft;
      visibility(x);
      onScrollRef.current();
      if (pending.current !== null) {
        if (Math.abs(x - pending.current) > 1) return;
        pending.current = null;
      }
      derive(x);
    };
    const end = () => {
      pending.current = null;
      derive(el.scrollLeft);
    };
    el.addEventListener("scroll", scroll, { passive: true });
    el.addEventListener("scrollend", end);
    return () => {
      el.removeEventListener("scroll", scroll);
      el.removeEventListener("scrollend", end);
    };
  }, [ref, enabled, choose, visibility]);
  useEffect(() => () => window.clearTimeout(pendingTimer.current), []);

  const go = useCallback(
    (s: SlidesSide) => {
      const el = ref.current;
      choose(s);
      if (!el || !enabled) return;
      const x = s === "info" ? geo.current.offset : 0;
      if (Math.abs(el.scrollLeft - x) <= 1) return;
      pending.current = x;
      // scrollend が来ないブラウザでも、いずれは位置からタブを決め直す
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = window.setTimeout(() => (pending.current = null), 1200);
      el.scrollTo({ left: x, behavior: reduced() ? "auto" : "smooth" });
    },
    [ref, enabled, choose],
  );

  return { width, slidesW, offset, side: enabled ? side : "slides", slidesOff: enabled && slidesOff, infoOff: !enabled || infoOff, go };
}

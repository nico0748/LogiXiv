// テキスト層の「endOfContent」。pdf.js のビューア（web/text_layer_builder.js）と同じ振る舞いを移したもの。
//
// アプリは pdf.js の TextLayer を素のまま使っているので、ビューアが付け足すこの仕掛けが無かった。
// 無いと、文字の無いところ（行間・段の間・行末の余白）へ指が出た瞬間に選択の終わりが
// テキスト層の外（ページの先頭や末尾の要素）へ飛び、複数行のドラッグが空になったり途中で切れたりする。
//
// - 各テキスト層の末尾に div.endOfContent を置く（ふだんはテキスト層の下端の外、高さ 0）。
// - テキスト層の上で押したら .selecting を付ける。CSS（styles.css）が endOfContent を層いっぱいに広げ、
//   文字の無いところでも選択の終わりがその層の中に留まる。
// - Chromium（148 未満）では、選択の端の要素のすぐ後ろへ endOfContent を動かす
//   （そうしないと、文字の無いところで選択がページの末尾まで伸びる）。
// - 指を離したら元に戻す。

const layers = new Map<HTMLElement, HTMLElement>();
let listening: AbortController | null = null;

/** テキスト層を描き終えたら呼ぶ。返り値は片付け（テキスト層を作り直す・消すとき）。 */
export function attachEndOfContent(textLayer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  textLayer.append(end);
  const onDown = () => textLayer.classList.add("selecting");
  textLayer.addEventListener("mousedown", onDown);
  layers.set(textLayer, end);
  enableGlobalListener();
  return () => {
    textLayer.removeEventListener("mousedown", onDown);
    end.remove();
    textLayer.classList.remove("selecting");
    layers.delete(textLayer);
    if (layers.size === 0) {
      listening?.abort();
      listening = null;
    }
  };
}

function reset(end: HTMLElement, textLayer: HTMLElement) {
  textLayer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  textLayer.classList.remove("selecting");
}

/** endOfContent を動かす必要が無いブラウザ（Firefox と Chromium 148 以降）か。 */
let modernSelection: boolean | undefined;
function isModernSelection(sample: HTMLElement): boolean {
  if (modernSelection === undefined) {
    modernSelection = getComputedStyle(sample).getPropertyValue("-moz-user-select") === "none";
    if (!modernSelection) {
      const v = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
      modernSelection = !!v && Number.parseInt(v, 10) >= 148;
    }
  }
  return modernSelection;
}

function enableGlobalListener() {
  if (listening) return;
  listening = new AbortController();
  const { signal } = listening;
  let pointerDown = false;
  let prevRange: Range | null = null;
  const resetAll = () => layers.forEach(reset);
  document.addEventListener("pointerdown", () => (pointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  document.addEventListener("keyup", () => !pointerDown && resetAll(), { signal });
  document.addEventListener(
    "selectionchange",
    () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return resetAll();
      const active = new Set<HTMLElement>();
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        for (const tl of layers.keys()) if (!active.has(tl) && range.intersectsNode(tl)) active.add(tl);
      }
      for (const [tl, end] of layers) {
        if (active.has(tl)) tl.classList.add("selecting");
        else reset(end, tl);
      }
      const first = layers.keys().next().value;
      if (!first || isModernSelection(first)) return;

      const range = sel.getRangeAt(0);
      const modifyStart =
        !!prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0) {
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && !anchor.childNodes.length);
      }
      const parentEl = anchor?.parentElement;
      const tl = parentEl?.closest<HTMLElement>(".textLayer");
      const end = tl ? layers.get(tl) : undefined;
      if (tl && end && parentEl && anchor) {
        end.style.width = tl.style.width;
        end.style.height = tl.style.height;
        end.style.userSelect = "text";
        parentEl.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}

// 発表の窓（URL に ?present=<論文ID> を付けて開いた窓）。スライドと論文を並べて、いつも全画面の見た目で映す。
// 元の窓（台本）とは BroadcastChannel でやりとりする（lib/presenter.ts）。
// - 見えているスライドのページと、選んでいるグループを台本へ知らせる
// - 台本からの指示で、スライドのページを動かす・グループと論文の該当箇所を見せる・窓を閉じる
// グループの追加やリンクもこの窓でできる（保存先は元の窓と同じなので、元の窓にもそのまま映る）。

import { useCallback, useEffect, useRef, useState } from "react";
import { type ServerBackend, connectServer } from "../../lib/backend.ts";
import { type PresentMsg, presentChannel } from "../../lib/presenter.ts";
import { type Snack, Snackbar } from "../Snackbar.tsx";
import { type SlideFocus, SlidesView } from "./SlidesView.tsx";
import { useSlides } from "./useSlides.ts";

export function PresenterApp({ paperId }: { paperId: string }) {
  const [backend, setBackend] = useState<ServerBackend | null | undefined>(undefined);
  useEffect(() => {
    void connectServer().then((b) => setBackend(b));
  }, []);
  if (backend === undefined) return <div className="welcome" aria-busy="true" />;
  if (!backend) {
    return (
      <div className="welcome">
        <p>発表の窓は、PaperLens のアプリかローカルサーバーの画面から「発表」で開いてください。</p>
      </div>
    );
  }
  return <Presenting backend={backend} paperId={paperId} />;
}

function Presenting({ backend, paperId }: { backend: ServerBackend; paperId: string }) {
  const [snack, setSnack] = useState<Snack | null>(null);
  const notify = useCallback((message: string) => setSnack({ message, n: Date.now() }), []);
  const slides = useSlides(backend, paperId, {
    active: true,
    // ノートと保存の状態は元の窓が持つ（保存先から読み直す）
    onNote: () => undefined,
    onSave: (st) => typeof st === "object" && notify(`保存できませんでした: ${st.error}`),
  });
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    backend.loadPdf(paperId).then(setPdf, (e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  }, [backend, paperId, notify]);
  useEffect(() => {
    void backend
      .listPapers()
      .then((ps) => {
        const t = ps.find((p) => p.id === paperId)?.title;
        document.title = t ? `発表: ${t}` : "PaperLens 発表";
      })
      .catch(() => undefined);
  }, [backend, paperId]);

  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<SlideFocus | null>(null);
  const [isolate, setIsolate] = useState(false);
  const [slideGoto, setSlideGoto] = useState<{ page: number; n: number } | null>(null);

  // --- 台本とのやりとり ---------------------------------------------------------
  const chan = useRef<BroadcastChannel | null>(null);
  const pos = useRef({ page: 1, count: 0 });
  useEffect(() => {
    const c = presentChannel(paperId);
    chan.current = c;
    const send = (m: PresentMsg) => c.postMessage(m);
    c.onmessage = (e: MessageEvent<PresentMsg>) => {
      const m = e.data;
      if (m.t === "ping") send({ t: "hello", ...pos.current });
      else if (m.t === "goto") setSlideGoto({ page: m.page, n: Date.now() });
      else if (m.t === "focus") {
        setActive(m.id);
        setFocus({ id: m.id, link: m.link, nonce: Date.now() });
      } else if (m.t === "close") window.close();
    };
    send({ t: "hello", ...pos.current });
    const bye = () => send({ t: "bye" });
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      c.close();
      chan.current = null;
    };
  }, [paperId]);
  const onSlidePage = useCallback((page: number, count: number) => {
    pos.current = { page, count };
    chan.current?.postMessage({ t: "page", page, count } satisfies PresentMsg);
  }, []);
  useEffect(() => {
    chan.current?.postMessage({ t: "active", id: active } satisfies PresentMsg);
  }, [active]);

  return (
    <div className="app presenter-app">
      <SlidesView
        slides={slides}
        paperId={paperId}
        paperPdf={pdf}
        active={active}
        setActive={setActive}
        hover={hover}
        setHover={setHover}
        focus={focus}
        notify={notify}
        isolate={isolate}
        setIsolate={setIsolate}
        presentation
        onSlidePage={onSlidePage}
        slideGoto={slideGoto}
      />
      <Snackbar snack={snack} onClose={() => setSnack(null)} />
    </div>
  );
}

import { Maximize2, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Link } from "../lib/backend.ts";
import type { PaperSummary } from "../lib/papers.ts";
import { EmptyState } from "./EmptyState.tsx";

interface Node {
  id: string;
  kind: "paper" | "term";
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 見ている範囲。x, y は画面の中心に来るグラフ上の点、k は拡大率。 */
interface Camera {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.15;
const MAX_K = 6;
/** 押した場所へ寄るときの 1 回ぶんの拡大率 */
const STEP_K = 1.8;
/** これ以上に寄っていれば必ず用語の名前を出す（全体を見ているときは字が重なって読めないので隠す） */
const TERM_LABEL_K = 1.1;

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

/**
 * 論文と用語のつながりを表示する。同じ用語を調べた論文どうしが近くに集まる。
 * 力学モデルによる配置を、依存ライブラリなしで計算している。
 *
 * 見え方は Obsidian のグラフに合わせる。開いたときは全体が収まる大きさで見せ、
 * 押した場所へ少しずつ寄っていく（ホイール・ピンチで拡大縮小、ドラッグで移動）。
 * 用語を押すとその意味を、論文を押すと題名と「開く」を出す（論文はダブルクリックでも開く）。
 */
export function GraphView({ papers, links, onOpen }: { papers: PaperSummary[]; links: Link[]; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [, setTick] = useState(0);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  /** 利用者が自分で動かしたら、配置が落ち着くまでの「全体に合わせる」をやめる */
  const touched = useRef(false);
  const anim = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { nodes, edges, neighbors, terms } = useMemo(() => {
    const nodes = new Map<string, Node>();
    const rnd = (s: number) => (Math.sin(s * 9301 + 49297) * 233280) % 1;
    let i = 0;
    const add = (id: string, kind: Node["kind"], label: string) => {
      if (!nodes.has(id)) {
        i++;
        nodes.set(id, { id, kind, label, x: rnd(i) * 300, y: rnd(i + 0.5) * 300, vx: 0, vy: 0 });
      }
    };
    for (const p of papers) add(`p:${p.id}`, "paper", p.title);
    const edges: [string, string][] = [];
    const seen = new Set<string>();
    const neighbors = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      for (const [x, y] of [[a, b], [b, a]] as const) {
        const set = neighbors.get(x);
        if (set) set.add(y);
        else neighbors.set(x, new Set([y]));
      }
    };
    /** 用語ごとの意味（論文ごと）。関連語として出てくるだけの用語は空 */
    const terms = new Map<string, Link[]>();
    for (const l of links) {
      const t = `t:${l.term.toLowerCase()}`;
      add(t, "term", l.term);
      if (l.short || l.detail) {
        const list = terms.get(t);
        if (list) list.push(l);
        else terms.set(t, [l]);
      }
      const k = `p:${l.paper}|${t}`;
      if (!seen.has(k)) {
        seen.add(k);
        edges.push([`p:${l.paper}`, t]);
        link(`p:${l.paper}`, t);
      }
    }
    return { nodes: [...nodes.values()], edges, neighbors, terms };
  }, [papers, links]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /** すべての点が収まる見え方 */
  const fitCamera = useCallback((): Camera => {
    if (nodes.length === 0) return { x: 0, y: 0, k: 1 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
    }
    // 余白は画面上の px で取る。名前の文字は点の右へ出るので、右には字の幅ぶんを足す
    // （字は拡大率によらずほぼ同じ大きさで描くので、グラフの座標ではなく画面の幅で見込む）
    const pad = 48, label = 180, top = 40;
    const k = clampK(Math.min((size.w - pad * 2 - label) / Math.max(1, x1 - x0), (size.h - pad * 2 - top) / Math.max(1, y1 - y0), 1.5));
    return { x: (x0 + x1) / 2 + label / 2 / k, y: (y0 + y1) / 2 - top / 2 / k, k };
  }, [nodes, size]);
  const fitRef = useRef(fitCamera);
  fitRef.current = fitCamera;

  /** 見え方をなめらかに動かす */
  const flyTo = useCallback((to: Camera, ms = 380) => {
    cancelAnimationFrame(anim.current);
    const from = camRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - t) ** 3;
      // 拡大率は対数で補間する（寄るときも引くときも同じ速さに見える）
      const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
      setCam({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  // 配置の計算。落ち着くまでの間は、触られていなければ全体が収まるように合わせ続ける
  useEffect(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    touched.current = false;
    let frame = 0;
    let raf = 0;
    const step = () => {
      const alpha = Math.max(0.02, 1 - frame / 240);
      for (const a of nodes) {
        for (const b of nodes) {
          if (a === b) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, 25);
          const f = (1800 / d2) * alpha;
          a.vx += dx * f * 0.05;
          a.vy += dy * f * 0.05;
        }
        a.vx -= a.x * 0.004 * alpha;
        a.vy -= a.y * 0.004 * alpha;
      }
      for (const [s, t] of edges) {
        const a = byId.get(s)!, b = byId.get(t)!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - 90) / d) * 0.04 * alpha;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
      for (const n of nodes) {
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }
      frame++;
      setTick(frame);
      if (!touched.current) setCam(fitRef.current());
      if (frame < 300) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // fitCamera は大きさが変わるたびに作り直されるが、計算をやり直す必要はない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // 窓の大きさが変わったら、まだ触られていなければ合わせ直す
  useEffect(() => {
    if (!touched.current) setCam(fitCamera());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // 選んでいた点が消えたら（論文を消した・用語を消した）選択を外す
  useEffect(() => {
    if (selected && !byId.has(selected)) setSelected(null);
  }, [byId, selected]);

  /** 画面上の点（グラフの枠に対する px）をグラフの座標へ */
  const toWorld = (sx: number, sy: number, c = camRef.current) => ({
    x: c.x + (sx - size.w / 2) / c.k,
    y: c.y + (sy - size.h / 2) / c.k,
  });
  /** 画面上の点 (sx, sy) を動かさずに拡大率を k にする見え方 */
  const zoomAt = (sx: number, sy: number, k: number, c = camRef.current): Camera => {
    const p = toWorld(sx, sy, c);
    const nk = clampK(k);
    return { x: p.x - (sx - size.w / 2) / nk, y: p.y - (sy - size.h / 2) / nk, k: nk };
  };
  /** 押した場所へ、拡大しながら少し寄る（1 回で真ん中へ飛ばず、近づいていく） */
  const stepToward = (sx: number, sy: number) => {
    const c = camRef.current;
    const p = toWorld(sx, sy, c);
    const k = clampK(c.k * STEP_K);
    flyTo({ x: c.x + (p.x - c.x) * 0.6, y: c.y + (p.y - c.y) * 0.6, k });
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  // ホイール（トラックパッドのピンチは ctrl 付きのホイールとして来る）で、指している場所を中心に拡大縮小する。
  // React の onWheel は passive なので preventDefault が効かない。自分で登録する
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      cancelAnimationFrame(anim.current);
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const c = camRef.current;
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        setCam(zoomAt(sx, sy, c.k * factor, c));
      } else {
        setCam({ ...c, x: c.x + e.deltaX / c.k });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // zoomAt は size に依存するので、大きさが変わったら付け直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // ドラッグで移動。動かさずに離したら「押した」として扱う
  const drag = useRef<{ sx: number; sy: number; cam: Camera; moved: boolean; node: string | null } | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".graph-ui")) return;
    const { sx, sy } = local(e);
    const node = (e.target as Element).closest<SVGGElement>("[data-node]")?.dataset.node ?? null;
    drag.current = { sx, sy, cam: camRef.current, moved: false, node };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { sx, sy } = local(e);
    if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      touched.current = true;
      cancelAnimationFrame(anim.current);
    }
    setCam({ ...d.cam, x: d.cam.x - (sx - d.sx) / d.cam.k, y: d.cam.y - (sy - d.sy) / d.cam.k });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    touched.current = true;
    if (d.node) {
      // 押したまま捕まえているので dblclick の的は点にならない。2 回目の押下を自分で数える
      const now = performance.now();
      const last = lastTap.current;
      lastTap.current = { id: d.node, at: now };
      if (last && last.id === d.node && now - last.at < 350 && d.node.startsWith("p:")) return onOpen(d.node.slice(2));
      pick(d.node);
    } else {
      setSelected(null);
      const { sx, sy } = local(e);
      stepToward(sx, sy);
    }
  };

  /** 点を選ぶ。その点が真ん中に来るように、少し拡大しながら寄る */
  const pick = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    setSelected(id);
    const c = camRef.current;
    const k = clampK(Math.max(c.k * 1.4, 1.4));
    // 右上に説明のカードが出るので、点はカードに隠れない左寄りに置く（狭い画面では真ん中のまま）
    const shift = size.w > 640 ? Math.min(190, size.w / 4) : 0;
    flyTo({ x: n.x + shift / k, y: n.y, k });
  };

  const zoomBy = (factor: number) => {
    touched.current = true;
    flyTo(zoomAt(size.w / 2, size.h / 2, camRef.current.k * factor), 220);
  };
  const fitAll = () => {
    touched.current = true;
    setSelected(null);
    flyTo(fitCamera());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "+" || e.key === "=") zoomBy(1.4);
    else if (e.key === "-") zoomBy(1 / 1.4);
    else if (e.key === "0") fitAll();
    else if (e.key === "Escape") setSelected(null);
    else return;
    e.preventDefault();
  };

  // 選んだ点（なければカーソルの点）とその隣だけを濃く出す
  const focusId = selected ?? hover;
  const lit = focusId ? new Set([focusId, ...(neighbors.get(focusId) ?? [])]) : null;
  const sel = selected ? byId.get(selected) : undefined;
  const k = cam.k;
  // 全体を見ている間は用語の名前を隠し、1 段寄ったら出す（Obsidian と同じく、引くと点だけになる）
  const showTermLabels = k >= Math.min(TERM_LABEL_K, fitCamera().k * 1.5);

  return (
    <div
      className="graph"
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className="graph-legend graph-ui">● 論文　○ 用語　押した所へ寄る・ホイールで拡大縮小・ドラッグで移動</div>
      {nodes.length === 0 ? (
        <div style={{ paddingTop: 40 }}><EmptyState title="表示する論文がありません">論文を取り込み、用語を調べると表示されます。</EmptyState></div>
      ) : (
        <>
          <svg role="img" aria-label="論文と用語のつながり">
            {/* --k は拡大率。線の太さと字の大きさを画面上で保つために CSS で割る */}
            <g transform={`translate(${size.w / 2},${size.h / 2}) scale(${k}) translate(${-cam.x},${-cam.y})`} style={{ "--k": k } as React.CSSProperties}>
              {edges.map(([s, t]) => {
                const a = byId.get(s)!, b = byId.get(t)!;
                const on = lit ? lit.has(s) && lit.has(t) : false;
                return (
                  <line
                    key={`${s}-${t}`}
                    className={`edge${on ? " is-lit" : lit ? " is-dim" : ""}`}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  />
                );
              })}
              {nodes.map((n) => {
                const cls = `${n.kind === "paper" ? "n-paper" : "n-term"}${n.id === selected ? " is-selected" : ""}${lit && !lit.has(n.id) ? " is-dim" : ""}`;
                // 円は拡大率の平方根で大きくし（引いても点が消えず、寄っても大きくなりすぎない）、
                // 字は画面上でいつも同じ大きさにする（引いても読める）
                const r = (n.kind === "paper" ? 9 : 5) * Math.sqrt(Math.min(k, 2)) / k;
                const label = n.kind === "paper" ? (n.label.length > 36 ? `${n.label.slice(0, 36)}…` : n.label) : n.label;
                const showLabel = n.kind === "paper" || showTermLabels || (lit?.has(n.id) ?? false);
                return (
                  <g
                    key={n.id}
                    data-node={n.id}
                    className={cls}
                    transform={`translate(${n.x},${n.y})`}
                    tabIndex={0}
                    role="button"
                    aria-label={n.kind === "paper" ? `${n.label}（論文）` : `${n.label}（用語）`}
                    aria-pressed={n.id === selected}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      touched.current = true;
                      if (n.kind === "paper" && n.id === selected) onOpen(n.id.slice(2));
                      else pick(n.id);
                    }}
                  >
                    {/* 当たり判定は見た目より大きく取る（引いて見ているときの点は数 px しかない） */}
                    <circle className="hit" r={Math.max(r, 11 / k)} />
                    <circle r={r} />
                    {showLabel && <text x={r + 4 / k} y={4 / k}>{label}</text>}
                  </g>
                );
              })}
            </g>
          </svg>
          {sel && (
            <NodeCard
              node={sel}
              meanings={terms.get(sel.id) ?? []}
              linked={[...(neighbors.get(sel.id) ?? [])].map((id) => byId.get(id)).filter((x): x is Node => !!x)}
              papers={papers}
              onOpen={onOpen}
              onPick={(id) => {
                touched.current = true;
                pick(id);
              }}
              onClose={() => setSelected(null)}
            />
          )}
          <div className="graph-zoom graph-ui" role="toolbar" aria-label="グラフの表示">
            <button type="button" className="clickable-icon" title="拡大（+）" aria-label="拡大" onClick={() => zoomBy(1.4)}><Plus size={16} /></button>
            <button type="button" className="clickable-icon" title="縮小（-）" aria-label="縮小" onClick={() => zoomBy(1 / 1.4)}><Minus size={16} /></button>
            <button type="button" className="clickable-icon" title="全体を表示（0）" aria-label="全体を表示" onClick={fitAll}><Maximize2 size={15} /></button>
          </div>
        </>
      )}
    </div>
  );
}

/** 選んだ点の説明。用語なら論文ごとの意味、論文なら題名と「開く」。 */
function NodeCard({
  node,
  meanings,
  linked,
  papers,
  onOpen,
  onPick,
  onClose,
}: {
  node: Node;
  meanings: Link[];
  linked: Node[];
  papers: PaperSummary[];
  onOpen: (id: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const titleOf = (id: string) => papers.find((p) => p.id === id)?.title ?? id;
  const reading = meanings.find((m) => m.reading)?.reading;
  return (
    <section className="graph-card graph-ui" aria-label={`${node.label} の説明`} onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <div>
          <div className="graph-card-kind">{node.kind === "paper" ? "論文" : "用語"}</div>
          <h3>{node.label}</h3>
          {reading && <div className="graph-card-reading">{reading}</div>}
        </div>
        <button type="button" className="clickable-icon" aria-label="閉じる" onClick={onClose}><X size={14} /></button>
      </header>
      {node.kind === "paper" ? (
        <>
          <button type="button" className="btn primary sm" onClick={() => onOpen(node.id.slice(2))}>この論文を開く</button>
          {linked.length > 0 && (
            <>
              <div className="graph-card-sub">調べた用語 {linked.length}</div>
              <div className="graph-card-chips">
                {linked.map((t) => (
                  <button key={t.id} type="button" className="chip" onClick={() => onPick(t.id)}>{t.label}</button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {meanings.length === 0 ? (
            <p className="graph-card-empty">意味はまだ登録されていません（関連語として出てきた用語です）。</p>
          ) : (
            meanings.map((m, i) => (
              <div key={`${m.paper}-${i}`} className="graph-card-meaning">
                {m.short && <p className="graph-card-short">{m.short}</p>}
                {m.detail && <p className="graph-card-detail">{m.detail}</p>}
                {m.inPaper && <p className="graph-card-detail">この論文では: {m.inPaper}</p>}
                {meanings.length > 1 && <div className="graph-card-from">{titleOf(m.paper)}</div>}
              </div>
            ))
          )}
          {linked.length > 0 && (
            <>
              <div className="graph-card-sub">出てくる論文</div>
              <ul className="graph-card-papers">
                {linked.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="link-btn" onClick={() => onOpen(p.id.slice(2))}>{p.label}</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

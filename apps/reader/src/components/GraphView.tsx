import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * 論文と用語のつながりを表示する。同じ用語を調べた論文どうしが近くに集まる。
 * 力学モデルによる配置を、依存ライブラリなしで計算している。
 */
export function GraphView({
  papers,
  links,
  onOpen,
}: {
  papers: PaperSummary[];
  links: { paper: string; term: string }[];
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [, setTick] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { nodes, edges } = useMemo(() => {
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
    for (const l of links) {
      const t = `t:${l.term.toLowerCase()}`;
      add(t, "term", l.term);
      const k = `p:${l.paper}|${t}`;
      if (!seen.has(k)) {
        seen.add(k);
        edges.push([`p:${l.paper}`, t]);
      }
    }
    return { nodes: [...nodes.values()], edges };
  }, [papers, links]);

  useEffect(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
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
      if (frame < 300) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges]);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cx = size.w / 2, cy = size.h / 2;
  return (
    <div className="graph" ref={ref}>
      <div className="graph-legend">● 論文　○ 用語　論文を選ぶと開きます</div>
      {nodes.length === 0 ? (
        <div style={{ paddingTop: 40 }}><EmptyState title="表示する論文がありません">論文を取り込み、用語を調べると表示されます。</EmptyState></div>
      ) : (
        <svg role="img" aria-label="論文と用語のつながり">
          <g transform={`translate(${cx},${cy})`}>
            {edges.map(([s, t]) => {
              const a = byId.get(s)!, b = byId.get(t)!;
              return <line key={`${s}-${t}`} className="edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })}
            {nodes.map((n) =>
              n.kind === "paper" ? (
                <g
                  key={n.id}
                  className="n-paper"
                  transform={`translate(${n.x},${n.y})`}
                  onClick={() => onOpen(n.id.slice(2))}
                  tabIndex={0}
                  role="button"
                  aria-label={`${n.label} を開く`}
                  onKeyDown={(e) => e.key === "Enter" && onOpen(n.id.slice(2))}
                >
                  <circle r={9} />
                  <text x={13} y={4}>{n.label.length > 36 ? `${n.label.slice(0, 36)}…` : n.label}</text>
                </g>
              ) : (
                <g key={n.id} className="n-term" transform={`translate(${n.x},${n.y})`}>
                  <circle r={5} />
                  <text x={9} y={4}>{n.label}</text>
                </g>
              ),
            )}
          </g>
        </svg>
      )}
    </div>
  );
}

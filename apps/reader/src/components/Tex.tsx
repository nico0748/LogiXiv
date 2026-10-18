import katex from "katex";
import { useMemo } from "react";

export function Tex({ tex }: { tex: string }) {
  const html = useMemo(() => {
    try {
      return { ok: true, html: katex.renderToString(tex || "\\;", { displayMode: true, throwOnError: true, strict: "ignore" }) };
    } catch (e) {
      return { ok: false, html: e instanceof Error ? e.message : String(e) };
    }
  }, [tex]);
  if (!html.ok) return <div className="katex-box"><span className="err-msg">TeX を表示できません: {html.html.replace(/^KaTeX parse error: /, "")}</span></div>;
  return <div className="katex-box" dangerouslySetInnerHTML={{ __html: html.html }} />;
}

/** 行の中の短い TeX（記号）。書きかけで崩れていても、そのまま文字で見せる。 */
export function TexInline({ tex }: { tex: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: false, throwOnError: true, strict: "ignore" });
    } catch {
      return null;
    }
  }, [tex]);
  if (html === null) return <code>{tex}</code>;
  return <span className="tex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

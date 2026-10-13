"""
文字 1 つずつの位置（正解）を PDF から書き出す。scripts/measure-edges.ts が使う。

pdf.js とは別の実装（MuPDF / PyMuPDF）で取るのが要点。解析器と同じ pdf.js の
値を正解にすると、pdf.js の文字片の粒度という「測りたい誤差」そのものが正解に写る。

  python3 scripts/glyph-truth.py paper.pdf > glyphs.json

出力: [{"page": 1, "chars": [[c, x0, y0, x1, y1], ...]}, ...]
座標は左上原点・pt（pdf.js の viewport scale=1 と同じ向き）。合字は展開する（ﬁ → f, i）。
"""

import json
import sys

import fitz  # PyMuPDF

doc = fitz.open(sys.argv[1])
out = []
for index, page in enumerate(doc):
    chars = []
    # 合字を保たない（＝ ﬁ を f と i に割って、それぞれに幅を按分した箱を付ける）。
    flags = fitz.TEXT_PRESERVE_WHITESPACE
    raw = page.get_text("rawdict", flags=flags)
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            # 回った文字（図の軸ラベル）は文の枠の対象外。
            dx, dy = line.get("dir", (1, 0))
            if abs(dy) > 0.2:
                continue
            for span in line.get("spans", []):
                for ch in span.get("chars", []):
                    c = ch["c"]
                    if c.isspace():
                        continue
                    x0, y0, x1, y1 = ch["bbox"]
                    chars.append([c, round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)])
    out.append({"page": index + 1, "chars": chars})
json.dump(out, sys.stdout, ensure_ascii=False)

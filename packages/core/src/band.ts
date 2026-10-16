/**
 * 1 行の文字が縦に占める帯（マーカー・文の枠・AI エージェントのマーカーの上端と下端）。
 *
 * 以前は 3 か所が別々の式で縦の範囲を決めていた:
 *   - 文の枠（packages/server の fallback-worker）… ベースライン − 1em 〜 ベースライン
 *   - MCP の add_highlight（apps/reader/server/pdftext.ts）… ベースライン − 1em 〜 + 0.15em
 *   - 画面で選んだマーカー … テキスト層の箱（代わりのフォントの ascent で、およそ −0.88em 〜 +0.25em）
 * 実測（MuPDF の字の箱と描いたインクとの比較）では、どれも 0.1〜0.25em 上にずれていて、
 * 同じ文でも引いた経路によって高さが違っていた。ここに 1 つだけ置き、3 か所とも使う。
 *
 * 帯は書体の ascent / descent（pdf.js の textContent.styles）から決める。
 * MuPDF と同じく、ascent − descent が 1em に満たない書体（Computer Modern は 0.678 / −0.216）は
 * 1em に伸ばす（そのままだと字の上下が切れて見える。比率は保つので、ベースラインの位置は動かない）。
 * 値が無い・おかしい書体（Type3、埋め込みの壊れた書体。pdf.js は 0 / 0 を返す）は既定値を使う。
 *
 * どこからでも読めるように、何も import しない（画面のバンドルは @paperlens/core/band だけを読む）。
 */

/**
 * 文の枠の縦の帯をこの規則（lineBand）で決めた版。DocumentStructure.rectBand に入れる。
 * これより古い（無い）文書は、読み込むときにグリフの帯へ合わせ直す（apps/reader/server/sentences.ts）。
 */
export const RECT_BAND_VERSION = 1;

/** 書体の情報が使えないときの ascent / descent（em、descent は下向きを正）。 */
export const DEFAULT_ASCENT = 0.8;
export const DEFAULT_DESCENT = 0.2;

export interface BandMetrics {
  /** ベースラインから帯の上端まで（em） */
  ascent: number;
  /** ベースラインから帯の下端まで（em、下向きが正） */
  descent: number;
}

/**
 * 書体の ascent / descent（pdf.js の流儀: descent は負）から、帯の上下の幅を決める。
 * 範囲外の値は信用せず既定値にする。
 */
export function bandMetrics(ascent?: number | null, descent?: number | null): BandMetrics {
  let a = typeof ascent === 'number' && Number.isFinite(ascent) ? ascent : NaN;
  // descent は負で来るのが普通だが、正で入れる PDF もあるので絶対値で見る
  let d = typeof descent === 'number' && Number.isFinite(descent) ? Math.abs(descent) : NaN;
  if (!(a >= 0.5 && a <= 1.2) || !(d >= 0.05 && d <= 0.45)) {
    a = DEFAULT_ASCENT;
    d = DEFAULT_DESCENT;
  }
  const total = a + d;
  if (total < 1) {
    a /= total;
    d /= total;
  }
  return { ascent: a, descent: d };
}

/**
 * ベースライン（y 下向きの座標）と字の大きさから、帯の上端・下端を返す。
 * 単位は呼び出し側の座標のまま（pt でも px でも、ページに対する割合でもよい）。
 */
export function lineBand(baseline: number, size: number, metrics: BandMetrics = bandMetrics()): { y0: number; y1: number } {
  return { y0: baseline - metrics.ascent * size, y1: baseline + metrics.descent * size };
}

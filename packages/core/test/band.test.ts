import test from 'node:test';
import assert from 'node:assert/strict';

import { bandMetrics, DEFAULT_ASCENT, DEFAULT_DESCENT, lineBand } from '../src/band.ts';

/**
 * 行の帯（マーカー・文の枠・MCP のマーカーの上端と下端）の規則。
 * 期待値は MuPDF（PyMuPDF）が返す字の箱と同じ: ascent − descent が 1em 未満の書体は 1em に伸ばす。
 */

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-3, `${what}: ${a} != ${b}`);

test('Computer Modern（0.678 / −0.216）は 1em に伸ばし、MuPDF の箱 [−0.758, +0.242]em と一致する', () => {
  const m = bandMetrics(0.678, -0.216);
  close(m.ascent, 0.758, 'ascent');
  close(m.descent, 0.242, 'descent');
  const b = lineBand(100, 10, m);
  close(b.y0, 92.416, '上端');
  close(b.y1, 102.416, '下端');
});

test('ascent − descent が 1em 以上の書体（和文 0.88 / −0.12）はそのまま', () => {
  const m = bandMetrics(0.88, -0.12);
  close(m.ascent, 0.88, 'ascent');
  close(m.descent, 0.12, 'descent');
  const big = bandMetrics(0.95, -0.3);
  close(big.ascent, 0.95, 'ascent');
  close(big.descent, 0.3, 'descent');
});

test('書体の値が無い・おかしいときは既定値（0.8 / 0.2）', () => {
  for (const [a, d] of [
    [0, 0], // pdf.js が値を持たない書体に返すもの
    [undefined, undefined],
    [null, null],
    [Number.NaN, -0.2],
    [3, -0.2], // ascent が大きすぎる
    [0.8, -0.9], // descent が大きすぎる
  ] as const) {
    const m = bandMetrics(a, d);
    close(m.ascent, DEFAULT_ASCENT, `ascent (${a}, ${d})`);
    close(m.descent, DEFAULT_DESCENT, `descent (${a}, ${d})`);
  }
  const b = lineBand(50, 12);
  close(b.y0, 50 - 0.8 * 12, '上端');
  close(b.y1, 50 + 0.2 * 12, '下端');
});

test('descent を正で入れた PDF も同じに扱う', () => {
  const a = bandMetrics(0.7, -0.25);
  const b = bandMetrics(0.7, 0.25);
  assert.deepEqual(a, b);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { importPaper, loadNote } from "./papers.ts";
import {
  type SlideDeck,
  type SlideMarkup,
  applyMarkupOps,
  changeMarkups,
  diffMarkups,
  emptyDeck,
  findMarkup,
  loadDeck,
  markupName,
  nextColor,
  nextIndex,
  normalizeRect,
  parseMarkupOps,
  putSlides,
  renderSlideLinks,
  restoreMarkup,
} from "./slides.ts";
import { MemoryVault } from "./vault.ts";

const mk = (page: number, index: number, extra: Partial<SlideMarkup> = {}): SlideMarkup => ({
  id: `m-${page}-${index}`,
  page,
  index,
  rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
  color: 0,
  memo: "",
  links: [],
  createdAt: "",
  ...extra,
});
const deckOf = (markups: SlideMarkup[]): SlideDeck => ({ ...emptyDeck("talk.pdf"), markups });
const PDF = new TextEncoder().encode("%PDF-1.4\n").buffer as ArrayBuffer;

test("名前は Markup-ページ.番号（2 桁でそろえる）", () => {
  assert.equal(markupName({ page: 3, index: 2 }), "Markup-03.02");
  assert.equal(markupName({ page: 12, index: 10 }), "Markup-12.10");
});

test("名前・短い形・ID のどれでも探せる", () => {
  const d = deckOf([mk(3, 1), mk(3, 2)]);
  assert.equal(findMarkup(d, "Markup-03.02")?.id, "m-3-2");
  assert.equal(findMarkup(d, "markup-3.2")?.id, "m-3-2");
  assert.equal(findMarkup(d, "03.01")?.id, "m-3-1");
  assert.equal(findMarkup(d, "m-3-1")?.index, 1);
  assert.equal(findMarkup(d, "Markup-04.01"), undefined);
});

test("番号はページごとに数え、消した番号は使い直さない", () => {
  const ms = [mk(3, 1), mk(3, 3), mk(5, 1)];
  assert.equal(nextIndex(ms, 3), 4);
  assert.equal(nextIndex(ms, 5), 2);
  assert.equal(nextIndex(ms, 7), 1);
});

test("色は使っている数が最も少ないものを、並びの順に選ぶ", () => {
  assert.equal(nextColor([]), 0);
  assert.equal(nextColor([mk(1, 1, { color: 0 }), mk(1, 2, { color: 1 })]), 2);
  assert.equal(nextColor([mk(1, 1, { color: 0 }), mk(1, 2, { color: 2 })]), 1);
});

test("四角は 0〜1 に収め、逆向きにドラッグしても幅と高さは正になる", () => {
  assert.deepEqual(normalizeRect({ x: 0.5, y: 0.5, w: -0.2, h: -0.1 }), { x: 0.3, y: 0.4, w: 0.2, h: 0.09999999999999998 });
  assert.deepEqual(normalizeRect({ x: 0.9, y: -0.1, w: 0.5, h: 0.3 }), { x: 0.9, y: 0, w: 0.09999999999999998, h: 0.19999999999999998 });
});

test("差分の操作を当てると同じ状態になる。別の書き手の追加は残る", () => {
  const base = deckOf([mk(1, 1), mk(2, 1)]);
  const mine = deckOf([{ ...mk(1, 1), memo: "要点" }, mk(3, 1)]);
  const ops = diffMarkups(base, mine);
  assert.deepEqual(ops.map((o) => o.op).sort(), ["add", "remove", "update"]);
  // 保存先には、エージェントが足したリンクがある
  const theirs = applyMarkupOps(base, [{ op: "update", id: "m-2-1", patch: { memo: "エージェント" } }, { op: "add", item: mk(4, 1) }]);
  const merged = applyMarkupOps(theirs, ops);
  assert.deepEqual(merged.markups.map(markupName).sort(), ["Markup-01.01", "Markup-03.01", "Markup-04.01"]);
  assert.equal(merged.markups.find((m) => m.id === "m-1-1")?.memo, "要点");
});

test("同じページに同時に足して名前がぶつかったら、後のものを次の番号にずらす。名前は update で変わらない", () => {
  const d = applyMarkupOps(deckOf([mk(3, 1)]), [{ op: "add", item: { ...mk(3, 1), id: "other" } }]);
  assert.deepEqual(d.markups.map(markupName), ["Markup-03.01", "Markup-03.02"]);
  // 送られてきた patch に page や index があっても使わない
  const u = applyMarkupOps(d, parseMarkupOps([{ op: "update", id: "other", patch: { page: 9, index: 9, memo: "x" } }]));
  assert.equal(markupName(u.markups[1]), "Markup-03.02");
  assert.equal(u.markups[1].memo, "x");
});

test("ノートの一覧は、スライドの順に名前とリンク先を並べる", () => {
  const md = renderSlideLinks(
    deckOf([
      mk(3, 2, { memo: "提案手法", links: [{ id: "l1", kind: "text", page: 2, rects: [], text: "We  propose\nX.", createdAt: "" }] }),
      mk(1, 1, { links: [{ id: "l2", kind: "figure", page: 4, rects: [], text: "", createdAt: "" }] }),
      mk(2, 1),
    ]),
  );
  assert.equal(
    md,
    [
      "### Markup-01.01（スライド p.1）\n\n- 図: p.4",
      "### Markup-02.01（スライド p.2）\n\n（論文の該当箇所はまだありません）",
      "### Markup-03.02（スライド p.3）\n\n提案手法\n\n- 文章: p.2「We propose X.」",
    ].join("\n\n"),
  );
});

test("スライドを置いて差し替えても四角は残り、ノートに「発表スライドとの対応」ができる", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  assert.equal(await loadDeck(v, id), null);
  await putSlides(v, id, "talk.pdf", PDF);
  const r = await changeMarkups(v, id, [{ op: "add", item: mk(3, 2) }]);
  assert.match(r.note, /## 発表スライドとの対応\n\n<!-- list: slides -->\n### Markup-03\.02/);
  const again = await putSlides(v, id, "talk.pptx", PDF, PDF);
  assert.equal(again.convertedFrom, "pptx");
  assert.equal(again.markups.length, 1);
  assert.ok(await v.exists(`papers/${id}/slides.pptx`));
  // 全部消しても、一覧の節は空にして残す
  await changeMarkups(v, id, [{ op: "remove", id: "m-3-2" }]);
  assert.match(await loadNote(v, id), /<!-- list: slides -->\n<!-- \/list -->/);
});

test("PDF でないものはスライドとして置かない。スライドの無い論文には書かない", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await assert.rejects(putSlides(v, id, "x.pdf", new TextEncoder().encode("hello").buffer as ArrayBuffer), /PDF か PPTX/);
  await assert.rejects(changeMarkups(v, id, [{ op: "add", item: mk(1, 1) }]), /スライドがありません/);
});

const link = (id: string) => ({ id, kind: "text" as const, page: 1, rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }], text: id, createdAt: "" });

test("リンクは 1 本ずつの操作になり、別の書き手が同時に足したリンクを消さない", () => {
  const base = deckOf([mk(1, 1, { links: [link("a")] })]);
  const mine = deckOf([mk(1, 1, { links: [link("a"), link("mine")], memo: "m" })]);
  const ops = diffMarkups(base, mine);
  assert.deepEqual(ops.map((o) => o.op), ["update", "addLink"]);
  // 保存先には、エージェントが足したリンクがある
  const theirs = applyMarkupOps(base, [{ op: "addLink", id: "m-1-1", link: link("agent") }]);
  assert.deepEqual(applyMarkupOps(theirs, ops).markups[0].links.map((l) => l.id), ["a", "agent", "mine"]);
  // 外す・種類を変えるも 1 本ずつ
  const next = deckOf([mk(1, 1, { links: [{ ...link("a"), kind: "figure" }] })]);
  assert.deepEqual(diffMarkups(mine, next).map((o) => o.op), ["update", "removeLink", "updateLink"]);
});

test("正しくない操作は、何も書かずに断る", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await putSlides(v, id, "talk.pdf", PDF);
  await changeMarkups(v, id, [{ op: "add", item: mk(1, 1) }]);
  const cases: [unknown, RegExp][] = [
    [[{ op: "add", item: { id: "x", page: 1, index: 1 } }], /rect/],
    [[{ op: "add", item: { ...mk(2, 1), links: "zzz" } }], /links は配列/],
    [[{ op: "update", id: "m-1-1", patch: { rect: { x: "a", y: 0, w: 1, h: 1 } } }], /rect/],
    [[{ op: "add", item: { ...mk(1, 1), id: "y", page: -5 } }], /page は 1 以上/],
    [[{ op: "frobnicate", id: "m-1-1" }], /op は add/],
    [[null], /オブジェクト/],
    ["nope", /配列/],
    [[{ op: "addLink", id: "m-1-1", link: { ...link("z"), rects: [{ x: 5, y: 5, w: 1, h: 1 }] } }], /ページの外/],
  ];
  for (const [ops, re] of cases) await assert.rejects(changeMarkups(v, id, ops), re, JSON.stringify(ops));
  const d = await loadDeck(v, id);
  assert.deepEqual(d?.markups.map((m) => m.id), ["m-1-1"]);
});

test("手で壊された slides.json でも読める（壊れたグループとリンクだけを捨てる）", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await putSlides(v, id, "talk.pdf", PDF);
  await v.writeText(`papers/${id}/slides.json`, JSON.stringify({ markups: [{ id: "ok", page: 1, index: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, links: [link("a"), { id: "broken" }] }, { id: "no-rect", page: 1, index: 2 }, null] }));
  const d = await loadDeck(v, id);
  assert.deepEqual(d?.markups.map((m) => [m.id, m.memo, m.links.map((l) => l.id)]), [["ok", "", ["a"]]]);
  assert.match((await changeMarkups(v, id, [])).note, /### Markup-01\.01/);
});

test("並べて書いても、リンクは全部残る", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await putSlides(v, id, "talk.pdf", PDF);
  await changeMarkups(v, id, [{ op: "add", item: mk(1, 1) }]);
  await Promise.all(["a", "b", "c", "d"].map((x) => changeMarkups(v, id, [{ op: "addLink", id: "m-1-1", link: link(x) }])));
  assert.deepEqual((await loadDeck(v, id))?.markups[0].links.map((l) => l.id).sort(), ["a", "b", "c", "d"]);
});

test("最後の番号のグループを消しても、その番号は使い直さない", () => {
  const d = applyMarkupOps(deckOf([]), [{ op: "add", item: mk(3, 1) }, { op: "add", item: mk(3, 2) }, { op: "remove", id: "m-3-2" }]);
  assert.equal(nextIndex(d.markups, 3, d.used), 3);
  // 同じ名前で足し直されても、次の番号にずらす
  const again = applyMarkupOps(d, [{ op: "add", item: { ...mk(3, 2), id: "new" } }]);
  assert.equal(markupName(again.markups[1]), "Markup-03.03");
});

test("消したグループを元に戻すと、同じ ID・番号・リンクのまま、元の位置に戻る", () => {
  const gone = mk(3, 2, { links: [link("a"), link("b")] });
  const base = applyMarkupOps(deckOf([]), [{ op: "add", item: mk(3, 1) }, { op: "add", item: gone }, { op: "add", item: mk(4, 1) }]);
  const removed = { ...base, markups: base.markups.filter((m) => m.id !== gone.id) };
  const back = restoreMarkup(removed, gone, 1);
  assert.deepEqual(back.markups.map((m) => m.id), ["m-3-1", "m-3-2", "m-4-1"]);
  assert.equal(back.markups[1], gone);
  // 既にあるときは何もしない
  assert.equal(restoreMarkup(back, gone, 0), back);
  // 保存する前（消す → 戻す）なら、送る操作は無い
  assert.deepEqual(diffMarkups(base, back, new Set([gone.id])), []);
});

test("消したことを保存したあとに元に戻しても、名前は変わらない", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await putSlides(v, id, "talk.pdf", PDF);
  const gone = mk(3, 2, { links: [link("a")] });
  const saved = (await changeMarkups(v, id, [{ op: "add", item: mk(3, 1) }, { op: "add", item: gone }])).deck;
  const afterRemove = (await changeMarkups(v, id, diffMarkups(saved, { ...saved, markups: saved.markups.filter((m) => m.id !== gone.id) }))).deck;
  assert.equal(afterRemove.used?.[3], 2);
  const local = restoreMarkup(afterRemove, gone, 1);
  const ops = diffMarkups(afterRemove, local, new Set([gone.id]));
  assert.deepEqual(ops, [{ op: "restore", item: gone }]);
  // HTTP を通る形（JSON）にしても、戻す操作のまま届く
  const r = await changeMarkups(v, id, JSON.parse(JSON.stringify(ops)));
  const back = r.deck.markups.find((m) => m.id === gone.id);
  assert.equal(back && markupName(back), "Markup-03.02");
  assert.deepEqual(back?.links.map((l) => l.id), ["a"]);
  assert.match(r.note, /### Markup-03\.02/);
  // 同じ操作をもう一度当てても増えない
  assert.equal(applyMarkupOps(r.deck, ops).markups.length, r.deck.markups.length);
  // 戻す操作でなく足す操作（ほかの部分を足す）なら、これまでどおり次の番号にずらす
  const other = applyMarkupOps(afterRemove, [{ op: "add", item: { ...gone, id: "other" } }]);
  assert.equal(markupName(other.markups.at(-1)!), "Markup-03.03");
  // 戻すときでも、同じ名前が既にあればずらす
  const clash = applyMarkupOps(r.deck, parseMarkupOps([{ op: "restore", item: { ...gone, id: "x" } }]));
  assert.equal(markupName(clash.markups.at(-1)!), "Markup-03.03");
});

test("メモに HTML コメントの記号があっても、ノートの一覧の範囲は壊れない", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await putSlides(v, id, "talk.pdf", PDF);
  const r = await changeMarkups(v, id, [{ op: "add", item: mk(1, 1, { memo: "a <!-- /list --> b" }) }]);
  assert.equal(r.note.match(/<!-- \/list -->/g)?.length, (await loadNote(v, id)).match(/<!-- \/list -->/g)?.length);
  assert.doesNotMatch(r.note, /a <!-- \/list -->/);
  const again = await changeMarkups(v, id, [{ op: "update", id: "m-1-1", patch: { memo: "c" } }]);
  assert.match(again.note, /### Markup-01\.01（スライド p\.1）\n\nc\n/);
});

test("読めない slides.json は空として扱わず、書き込みを止める", async () => {
  const v = new MemoryVault();
  const id = await importPaper(v, "paper.pdf", PDF, "Paper");
  await putSlides(v, id, "talk.pdf", PDF);
  await v.writeText(`papers/${id}/slides.json`, '{"markups": [');
  await assert.rejects(loadDeck(v, id), /JSON として読めません/);
  await assert.rejects(changeMarkups(v, id, [{ op: "add", item: mk(1, 1) }]), /JSON として読めません/);
  assert.equal(await v.readText(`papers/${id}/slides.json`), '{"markups": [');
});

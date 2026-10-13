// ヘッドレス Chromium での動作確認。Claude API は偽の応答に差し替える。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../dist-single/index.html", import.meta.url));
const server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); }).listen(4321);
const shotDir = process.argv[2] ?? "/tmp";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const calls = [];
await page.route("https://api.anthropic.com/**", async (route) => {
  const body = JSON.parse(route.request().postData());
  calls.push(body);
  const prompt = JSON.stringify(body.messages);
  let out;
  if (prompt.includes("訳す")) out = { translation: "Transformer モデルは長い学術文書を読むのが苦手である。自己注意（self-attention）の計算量が系列長の2乗で増えるためである。" };
  else if (prompt.includes("用語:")) out = { term: "自己注意（self-attention）", reading: "じこちゅうい", short: "系列内の各要素が他の全要素との関連度を計算し、重み付き和を求める仕組み。", detail: "クエリ・キー・バリューの3つの射影を使う。計算量は系列長の2乗に比例する。", inPaper: "計算量の問題を説明するために使われている。", related: ["Transformer", "スパース注意"] };
  else out = { tex: "\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V", explanation: "Q はクエリ、K はキー、V はバリュー、d_k はキーの次元である。" };
  await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({
    id: "msg_test", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
});

const step = async (name, fn) => { await fn(); console.log("✓", name); };

await page.goto("http://localhost:4321/#debug");
await step("最初の画面", async () => { await page.getByRole("heading", { name: "PaperLens" }).waitFor(); await page.screenshot({ path: `${shotDir}/01-welcome.png` }); });
await step("サンプルで開く", async () => {
  await page.getByRole("button", { name: "サンプルの論文で試す" }).click();
  await page.locator(".pdf-page[data-page='1'] .textLayer span").first().waitFor();
  await page.waitForTimeout(600);
});

await step("1 ファイル版は「PDF を追加」だけで、URL からの取り込みは出さない", async () => {
  await page.getByRole("button", { name: "PDF を追加" }).waitFor();
  if (await page.locator('button[aria-haspopup="menu"]', { hasText: "追加" }).count()) throw new Error("1 ファイル版に「追加」のメニューがある");
});

const select = async (needle, endNeedle) => page.evaluate(([needle, endNeedle]) => {
  const spans = [...document.querySelectorAll(".textLayer span")];
  const a = spans.find((s) => s.textContent.includes(needle));
  const b = endNeedle ? spans.find((s) => s.textContent.includes(endNeedle)) : a;
  const r = document.createRange();
  const ia = a.textContent.indexOf(needle);
  r.setStart(a.firstChild, ia);
  const ib = endNeedle ? b.textContent.indexOf(endNeedle) + endNeedle.length : ia + needle.length;
  r.setEnd(b.firstChild, ib);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.querySelector(".pdf-scroll").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}, [needle, endNeedle]);

await step("API キー未設定でマーカーを引く", async () => {
  await select("Transformer models struggle", "with sequence length.");
  await page.locator(".sel-menu").waitFor();
  await page.screenshot({ path: `${shotDir}/02-selection-menu.png` });
  await page.getByRole("button", { name: "水色のマーカーを引く" }).click();
  await page.locator(".card .orig").first().waitFor();
  await page.locator(".mk.cyan").first().waitFor();
});

await step("API キーを設定", async () => {
  await page.getByRole("button", { name: "Claude の設定" }).click();
  await page.getByLabel("API キー").fill("sk-ant-test");
  await page.getByRole("button", { name: "保存する" }).click();
});

await step("訳す", async () => {
  await page.getByRole("button", { name: "Claude で訳す" }).click();
  await page.getByText("Transformer モデルは長い学術文書").waitFor().catch(async () => {
    await page.locator("textarea.trans").first().inputValue().then((v) => { if (!v.includes("Transformer")) throw new Error("訳が入らない: " + v); });
  });
});

await step("用語を調べる", async () => {
  await select("self-attention");
  await page.getByRole("button", { name: "用語を調べる" }).click();
  await page.getByText("系列内の各要素が").waitFor();
});

await step("数式にする（画像を送る）", async () => {
  await select("Attention(Q, K, V)");
  await page.getByRole("button", { name: "数式にする" }).click();
  await page.locator(".katex-box .katex").first().waitFor();
  const last = calls[calls.length - 1];
  if (!last.messages[0].content.some((b) => b.type === "image")) throw new Error("画像が送られていない");
  if (last.fallbacks !== "default") throw new Error("fallbacks が無い");
  await page.screenshot({ path: `${shotDir}/03-math.png` });
});

await step("記録を入力", async () => {
  await page.getByRole("tab", { name: "記録" }).click();
  await page.getByLabel("一言でいうと").fill("窓付きの疎な注意で、長い論文を少ないメモリで読めるようにした。");
  await page.getByRole("radio", { name: "精読", exact: true }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shotDir}/04-record.png` });
});

const noteMd = () => page.evaluate(async () => {
  const v = window.__vault; const [d] = (await v.list("papers")); return v.readText(`papers/${d.name}/note.md`);
});

await step("段階のチップを矢印キーで選ぶ", async () => {
  await page.getByRole("radio", { name: "精読", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-checked") === "true" && document.activeElement.textContent === "検討");
  await page.waitForTimeout(300);
  if (!(await noteMd()).includes("status: 検討")) throw new Error("右矢印キーで段階が変わらない");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  if (!(await noteMd()).includes("status: 精読")) throw new Error("左矢印キーで段階が戻らない");
});

await step("書誌情報を入れて BibTeX をコピーする", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:4321" });
  const biblio = page.locator("details.biblio");
  if (!(await biblio.evaluate((d) => d.open))) await biblio.locator("summary").click();
  await page.getByLabel("著者", { exact: true }).fill("A. Example\nB. Sample");
  await page.getByLabel("年", { exact: true }).fill("2026");
  await page.waitForTimeout(1300);
  const note = await noteMd();
  if (!/\nauthors:\n {2}- "?A\. Example"?\n {2}- "?B\. Sample"?\n/.test(note)) throw new Error(`著者が一覧になっていない:\n${note.slice(0, 400)}`);
  await page.getByRole("button", { name: "BibTeX をコピー" }).click();
  await page.locator(".snackbar", { hasText: "BibTeX をコピーしました" }).waitFor();
  const bib = await page.evaluate(() => navigator.clipboard.readText());
  if (!bib.includes(" and ") || !bib.startsWith("@misc{example2026sparse,")) throw new Error(`BibTeX が違う: ${bib}`);
  await page.screenshot({ path: `${shotDir}/08-biblio.png` });
});

let md;
await step("note.md に反映されている", async () => {
  md = await page.evaluate(async () => {
    const v = window.__vault; const [d] = (await v.list("papers")); return v.readText(`papers/${d.name}/note.md`);
  });
  for (const want of ["status: 精読", "窓付きの疎な注意で", "> [!quote] p.1（水色）", "> 訳: Transformer モデルは", "### [[自己注意（self-attention）]]", "関連: [[Transformer]]", "$$\n\\mathrm{Attention}", "読む目的"]) {
    if (!md.includes(want)) throw new Error(`note.md に「${want}」が無い`);
  }
});

await step("検索の当たりから記録欄を開く", async () => {
  await page.getByLabel("論文とノートを検索").fill("窓付き");
  const hit = page.locator(".hit-item", { hasText: "一言でいうと" });
  await hit.waitFor();
  await page.screenshot({ path: `${shotDir}/09-search.png` });
  await page.getByRole("tab", { name: /訳/ }).click();
  await hit.click();
  await page.waitForFunction(() => document.activeElement?.id === "f-summary");
  await page.getByRole("button", { name: "検索を消す" }).click();
});

await step("段階で絞り込み、すべて表示で戻す", async () => {
  await page.getByRole("radiogroup", { name: "段階で絞り込む" }).getByRole("radio", { name: /^精読/ }).click();
  await page.locator(".filter-band", { hasText: "精読のみ表示" }).waitFor();
  await page.getByRole("button", { name: "すべて表示" }).click();
  await page.locator(".filter-band").waitFor({ state: "detached" });
});

await step("ページ番号を入れて移る", async () => {
  const input = page.getByLabel("ページ番号");
  await input.fill("2");
  await input.press("Enter");
  await page.waitForFunction(() => {
    const box = document.querySelector(".pdf-scroll").getBoundingClientRect();
    const top = document.querySelector('[data-page="2"]').getBoundingClientRect().top;
    return top >= box.top && top < box.bottom;
  });
  if ((await page.locator(".pdf-toolbar").textContent()).indexOf("/ 2 ページ") < 0) throw new Error("総ページ数が出ていない");
  await input.fill("1");
  await input.press("Enter");
});

await step("訳タブとマーカー連動", async () => {
  await page.getByRole("tab", { name: /訳/ }).click();
  await page.locator(".pdf-page button[aria-label^='p.1 のマーカー']").first().click();
  await page.locator(".card.active").waitFor();
  await page.screenshot({ path: `${shotDir}/05-translate.png` });
});

await step("グラフ", async () => {
  await page.getByRole("button", { name: "グラフで見る" }).click();
  await page.locator(".graph svg .n-term").first().waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shotDir}/06-graph.png` });
});

// マーカーの矩形の中の画素を調べる。最も暗い画素（文字）と、最も多い画素（紙に重ねたマーカーの色）を返す。
// 画像の読み取りはブラウザの canvas で行う（依存を増やさないため）
const MARKS = [["Transformer models struggle", "水色", "cyan", [193, 232, 255]], ["We propose sparse", "黄色", "yellow", [255, 224, 131]], ["Researchers spend", "桃色", "magenta", [255, 165, 220]], ["Prior work addresses", "緑色", "green", [103, 214, 143]]];
const measure = async (label) => {
  const boxes = [];
  for (const [, , cls] of MARKS) boxes.push(await page.locator(`.mk.${cls}`).first().boundingBox());
  const png = (await page.screenshot()).toString("base64");
  const res = await page.evaluate(async ([png, boxes]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return boxes.map((b) => {
      const d = ctx.getImageData(Math.round(b.x) + 2, Math.round(b.y) + 2, Math.round(b.width) - 4, Math.round(b.height) - 5).data;
      let min = 999, dark = null; const counts = {};
      for (let i = 0; i < d.length; i += 4) {
        const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (L < min) { min = L; dark = [d[i], d[i + 1], d[i + 2]]; }
        const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; counts[k] = (counts[k] || 0) + 1;
      }
      return { dark, mode: Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number) };
    });
  }, [png, boxes]);
  MARKS.forEach(([, , cls, want], i) => {
    const { dark, mode } = res[i];
    if (dark.some((v) => v > 40)) throw new Error(`${label}: ${cls} のマーカーの中の文字が暗くない: ${dark}`);
    if (mode.some((v, j) => Math.abs(v - want[j]) > 3)) throw new Error(`${label}: ${cls} のマーカーの色が違う: ${mode}（期待 ${want}）`);
  });
};

await step("暗い表示", async () => {
  await page.getByRole("button", { name: "論文の表示に戻る" }).click();
  await page.locator(".pdf-page[data-page='1'] .textLayer span").first().waitFor();
  await page.waitForTimeout(400);
  // 残りの 3 色のマーカーを引き、明暗の両方で文字が隠れないことを確かめる
  for (const [needle, name, cls] of MARKS.slice(1)) {
    await page.evaluate((needle) => {
      const a = [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.includes(needle));
      const r = document.createRange(); const i = a.textContent.indexOf(needle);
      r.setStart(a.firstChild, i); r.setEnd(a.firstChild, Math.min(a.textContent.length, i + 40));
      getSelection().removeAllRanges(); getSelection().addRange(r);
      document.querySelector(".pdf-scroll").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, needle);
    await page.locator(".sel-menu").waitFor();
    await page.getByRole("button", { name: `${name}のマーカーを引く` }).click();
    await page.locator(`.mk.${cls}`).first().waitFor();
  }
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator(".pdf-scroll").evaluate((el) => el.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await measure("明るい表示");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await measure("暗い表示");
  // ページの中は明るい表示の値、ページの外に出る番号は暗い表示の値になる
  const resolved = await page.evaluate(() => {
    const tl = document.querySelector(".pdf-page .textLayer");
    const s = document.createElement("span");
    s.style.color = "var(--md-sys-color-primary)";
    tl.appendChild(s);
    const primary = getComputedStyle(s).color;
    s.remove();
    return { primary, pageNo: getComputedStyle(document.querySelector(".page-no")).color };
  });
  if (resolved.primary !== "rgb(84, 90, 146)") throw new Error(`ページの中の primary が明るい表示の値でない: ${resolved.primary}`);
  if (resolved.pageNo !== "rgb(199, 197, 208)") throw new Error(`ページ番号の色が暗い表示の値でない: ${resolved.pageNo}`);
  await page.screenshot({ path: `${shotDir}/07-dark.png` });
  // ページの上のマーカーの点のフォーカス: 明るい表示の secondary の輪と、白い縁
  await page.keyboard.press("Shift");
  await page.locator(".pdf-page button[aria-label^='p.1 のマーカー']").nth(1).focus();
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return [cs.outlineColor, cs.boxShadow]; });
  if (ring[0] !== "rgb(91, 93, 114)" || !ring[1].includes("rgb(255, 255, 255)")) throw new Error(`マーカーの点のフォーカスの輪が違う: ${ring}`);
});

console.log("\n--- note.md ---\n" + md);
console.log("console errors:", errors.length ? errors : "なし");
await browser.close();
server.close();
if (errors.length) process.exit(1);

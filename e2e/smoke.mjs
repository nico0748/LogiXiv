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
  await page.getByRole("button", { name: "精読" }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shotDir}/04-record.png` });
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

await step("暗い表示", async () => {
  await page.getByRole("button", { name: "論文の表示に戻る" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotDir}/07-dark.png` });
});

console.log("\n--- note.md ---\n" + md);
console.log("console errors:", errors.length ? errors : "なし");
await browser.close();
server.close();
if (errors.length) process.exit(1);

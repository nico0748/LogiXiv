// 発表スライドと論文の対応の画面の動作確認。先に npm run build を実行しておく。保存先は一時フォルダを使う。
//
// 1. 論文と 2 ページのスライドを API で取り込む
// 2. 画面で「囲む」を選び、スライドの 2 ページ目を囲む → Markup-02.01 ができる
// 3. 論文の文を選んで「文章としてリンク」、図を囲んでリンクする → 線が 2 本引かれる
// 4. slides.json と note.md に残ること、MCP の書き込みで線が増えることを確かめる
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = mkdtempSync(path.join(tmpdir(), "paperlens-e2e-slides-"));
const shotDir = process.argv[2] ?? tmpdir();
const port = "5298";
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PAPERLENS_DATA: data, PAPERLENS_PORT: port, PAPERLENS_CONFIG: path.join(data, "config.json") };

const server = spawn(process.execPath, [path.join(root, "dist-server/server.js")], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (b) => String(b).includes("起動しました") && resolve());
  server.on("exit", (c) => reject(new Error(`サーバーが止まりました（${c}）`)));
});

const fail = (msg) => {
  throw new Error(msg);
};
const step = async (name, fn) => {
  await fn();
  console.log("✓", name);
};

let browser;
try {
  // 論文とスライドを取り込む
  const sample = readFileSync(path.join(root, "src/demo/sample.pdf"));
  const id = (await (await fetch(`${base}/api/papers?name=sample.pdf`, { method: "POST", body: sample })).json()).id;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([960, 540]).drawText("Sparse Window Attention", { x: 80, y: 260, size: 44, font });
  const p2 = doc.addPage([960, 540]);
  p2.drawText("Proposed method", { x: 80, y: 440, size: 36, font });
  p2.drawText("- windowed sparse attention", { x: 100, y: 360, size: 26, font });
  const r = await fetch(`${base}/api/papers/${id}/slides?name=talk.pdf`, { method: "POST", body: Buffer.from(await doc.save()) });
  if (!r.ok) fail(`スライドを取り込めませんでした: ${await r.text()}`);

  // 手元の Playwright の版に合うブラウザが無いときは、PW_CHROMIUM で実行ファイルを指定する
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);

  await step("リボンから「発表スライドと論文の対応」を開くと、左右に並ぶ", async () => {
    await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name: "発表スライドと論文の対応" }).click();
    await page.locator(".sv-slides .pp-page").nth(1).waitFor();
    await page.locator(".sv-paper .pp-page .textLayer span").first().waitFor();
  });

  await step("「囲む」でスライド 2 ページ目を囲むと Markup-02.01 ができる", async () => {
    await page.keyboard.press("r");
    const slide2 = page.locator(".sv-slides .pp-page").nth(1);
    await slide2.scrollIntoViewIfNeeded();
    const b = await slide2.boundingBox();
    await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.25, { steps: 6 });
    await page.mouse.up();
    await page.locator('.mu-box[aria-pressed="true"]', { hasText: "Markup-02.01" }).waitFor();
    await page.locator(".mp-item.is-active .mp-name", { hasText: "Markup-02.01" }).waitFor();
  });

  await step("論文の文を選んで「文章としてリンク」すると、線が引かれる", async () => {
    const span = page.locator(".sv-paper .textLayer span", { hasText: "Transformer" }).first();
    const b = await span.boundingBox();
    await page.mouse.move(b.x + 1, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.getByRole("toolbar", { name: "選んだ文をリンクする" }).getByRole("button", { name: "文章としてリンク" }).click();
    await page.locator(".sv-paper .ln-fills .ln-fill").first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 1);
  });

  await step("「図」で論文の範囲を囲むと、2 本目の線が引かれる", async () => {
    await page.getByRole("button", { name: "図", exact: true }).click();
    const p1 = await page.locator(".sv-paper .pp-page").first().boundingBox();
    await page.mouse.move(p1.x + p1.width * 0.15, p1.y + p1.height * 0.42);
    await page.mouse.down();
    await page.mouse.move(p1.x + p1.width * 0.6, p1.y + p1.height * 0.52, { steps: 6 });
    await page.mouse.up();
    await page.locator(".sv-paper .ln-figure .ln-frame").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 2);
    await page.keyboard.press("Escape");
  });

  await step("slides.json と note.md に残る", async () => {
    let deck;
    for (let i = 0; i < 30; i++) {
      deck = JSON.parse(readFileSync(path.join(data, "papers", id, "slides.json"), "utf8"));
      if (deck.markups[0]?.links.length === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const m = deck.markups[0];
    if (m.page !== 2 || m.index !== 1 || m.links.length !== 2) fail(`slides.json: ${JSON.stringify(deck)}`);
    if (!m.links.some((l) => l.kind === "text" && /Transformer/.test(l.text))) fail("文章のリンクがありません");
    const note = readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
    if (!/### Markup-02\.01（スライド p\.2）[\s\S]*- 文章: p\.1「Transformer/.test(note)) fail(`note.md:\n${note}`);
  });

  await page.screenshot({ path: path.join(shotDir, "slides-split.png") });

  await step("右サイドバーのリンクを外すと、線が 1 本になる", async () => {
    await page.getByRole("button", { name: /p\.1 のリンクを外す/ }).last().click();
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 1);
  });

  await step("ほかの書き手（MCP など）がファイルを書き換えると、画面に映る", async () => {
    // 画面の「外す」の保存（少し待ってから送る）が終わってから書く
    let deck;
    for (let i = 0; i < 30; i++) {
      deck = (await (await fetch(`${base}/api/papers/${id}/slides`)).json()).deck;
      if (deck.markups[0].links.length === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const m = deck.markups[0];
    const extra = { id: "l-agent", kind: "equation", page: 1, rects: [{ x: 0.2, y: 0.6, w: 0.5, h: 0.05 }], text: "", createdAt: "" };
    // 画面とは別の書き手として書く（x-paperlens-client を付けない＝通知が画面に届く）
    await fetch(`${base}/api/papers/${id}/slides/markups`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-paperlens-client": "agent" },
      body: JSON.stringify({ ops: [{ op: "addLink", id: m.id, link: extra }] }),
    });
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 2, null, { timeout: 5000 });
  });

  // 線の端が、四角とリンク先に付いているか（DOM の位置から確かめる）
  const linesAttached = () =>
    page.evaluate(() => {
      const svg = document.querySelector(".sv-lines").getBoundingClientRect();
      const out = [];
      for (const g of document.querySelectorAll(".sv-lines g")) {
        const cs = [...g.querySelectorAll("circle")].map((c) => ({ x: svg.left + +c.getAttribute("cx"), y: svg.top + +c.getAttribute("cy") }));
        if (cs.length < 2) continue;
        const box = document.querySelector(".mu-box").getBoundingClientRect();
        const near = (p, r) => p.x >= r.left - 3 && p.x <= r.right + 3 && p.y >= r.top - 3 && p.y <= r.bottom + 3;
        const targets = [...document.querySelectorAll(".ln-anchor")].map((e) => e.getBoundingClientRect());
        out.push(near(cs[0], box) && targets.some((t) => near(cs[1], t)));
      }
      return out;
    });

  await step("分割線をドラッグしても、線の端が四角とリンク先に付いてくる", async () => {
    const g = await page.locator(".sv-gutter").boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + 200);
    await page.mouse.down();
    await page.mouse.move(g.x - 180, g.y + 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const ok = await linesAttached();
    if (!ok.length || ok.includes(false)) fail(`線の端がずれています: ${JSON.stringify(ok)}`);
    await page.locator(".sv-gutter").dblclick();
  });

  await step("2 ページにまたがって選んでも、リンクは始めのページの文字だけになる", async () => {
    const before = (await (await fetch(`${base}/api/papers/${id}/slides`)).json()).deck.markups[0].links.length;
    await page.waitForTimeout(600); // 分割の幅を戻したあと、文字の層が描き直されるのを待つ
    await page.evaluate(() => {
      const box = document.querySelector(".sv-paper .pp-scroll");
      const p2 = document.querySelectorAll(".sv-paper .pp-page")[1];
      box.scrollTop = p2.offsetTop - box.clientHeight / 2;
    });
    await page.waitForTimeout(300);
    const [a, b] = await page.evaluate(() => {
      const pages = document.querySelectorAll(".sv-paper .pp-page");
      const spans = (p) => [...p.querySelectorAll(".textLayer span")].filter((x) => x.textContent.trim());
      const r = (e) => { const q = e.getBoundingClientRect(); return { x: q.x, y: q.y, width: q.width, height: q.height }; };
      return [r(spans(pages[0]).at(-1)), r(spans(pages[1])[0])];
    });
    await page.mouse.move(a.x + 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.getByRole("toolbar", { name: "選んだ文をリンクする" }).getByRole("button", { name: "文章としてリンク" }).click();
    let deck;
    for (let i = 0; i < 30; i++) {
      deck = (await (await fetch(`${base}/api/papers/${id}/slides`)).json()).deck;
      if (deck.markups[0].links.length > before) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const l = deck.markups[0].links.at(-1);
    if (l.page !== 1 || l.rects.some((r) => r.h > 0.1) || /Markup-|\s1\s/.test(l.text)) fail(`ページをまたいだ選択: ${JSON.stringify(l)}`);
  });

  await step("最後の番号のグループを消して足し直しても、同じ名前にならない", async () => {
    await page.locator(".mp-item.is-active .mp-delete").click();
    await page.locator(".mp-item.is-active .mp-delete.is-confirm").click();
    await page.waitForFunction(() => !document.querySelector(".mu-box"));
    await page.keyboard.press("r");
    const slide2 = await page.locator(".sv-slides .pp-page").nth(1).boundingBox();
    await page.mouse.move(slide2.x + slide2.width * 0.1, slide2.y + slide2.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(slide2.x + slide2.width * 0.4, slide2.y + slide2.height * 0.7, { steps: 5 });
    await page.mouse.up();
    await page.locator(".mu-box", { hasText: "Markup-02.02" }).waitFor();
  });

  await step("メモを打ってすぐ別の論文を開いても、メモは保存される", async () => {
    // 前の段階の保存（少し待ってから送る）が終わってから読み直す
    for (let i = 0; i < 30; i++) {
      const d = JSON.parse(readFileSync(path.join(data, "papers", id, "slides.json"), "utf8"));
      if (d.markups.some((m) => m.page === 2 && m.index === 2)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await fetch(`${base}/api/papers?name=other.pdf`, { method: "POST", body: sample });
    await page.reload();
    await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name: "発表スライドと論文の対応" }).click();
    await page.locator(".sv-slides .pp-page").first().waitFor();
    await page.locator(".mp-title", { hasText: "Markup-02.02" }).click();
    await page.locator(".mp-item.is-active textarea").fill("すぐ切り替える");
    // 保存を待たずに、左の論文一覧から別の論文を開く
    if ((await page.locator("aside.sidebar.left").getAttribute("aria-hidden")) === "true") await page.keyboard.press("Control+Backslash");
    await page.locator(".nav-file-title:not(.is-active)").first().click();
    let memo = "";
    for (let i = 0; i < 30 && memo !== "すぐ切り替える"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      memo = JSON.parse(readFileSync(path.join(data, "papers", id, "slides.json"), "utf8")).markups[0]?.memo;
    }
    if (memo !== "すぐ切り替える") fail(`メモが保存されていません: ${JSON.stringify(memo)}`);
    await page.waitForFunction(() => !document.querySelector(".status-bar")?.textContent?.includes("保存しています"));
  });

  await step("中身の壊れた PDF に差し替えようとしても、今のスライドは残る", async () => {
    const r = await fetch(`${base}/api/papers/${id}/slides?name=broken.pdf`, { method: "POST", body: "%PDF-1.4 garbage" });
    if (r.status !== 400) fail(`壊れた PDF を受け付けました: ${r.status}`);
    const pdf = await fetch(`${base}/api/papers/${id}/slides/pdf`);
    const head = Buffer.from(await pdf.arrayBuffer());
    if (head.length < 200) fail("スライドが上書きされました");
  });

  if (errors.length) fail(`コンソールのエラー:\n${errors.join("\n")}`);
  console.log(`スクリーンショット: ${path.join(shotDir, "slides-split.png")}`);
  console.log("papers:", readdirSync(path.join(data, "papers")).join(", "));
} finally {
  await browser?.close();
  server.kill();
}

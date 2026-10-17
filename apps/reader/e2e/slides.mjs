// 発表スライドと論文の対応の画面の動作確認。先に npm run build を実行しておく。保存先は一時フォルダを使う。
//
// 1. 論文と 2 ページのスライドを API で取り込む
// 2. 画面で「囲む」を選び、スライドの 2 ページ目を囲む → Markup-02.01 ができる
// 3. 論文の文を選んで「文章としてリンク」、図を囲んでリンクする → 線が 2 本引かれる
// 4. slides.json と note.md に残ること、MCP の書き込みで線が増えることを確かめる
// 5. 全画面（発表のとき）: ボタンと P キーで入る・出る、見出しが隠れる、線がずれない、帯が上の端で出る、使えないときはウィンドウいっぱい
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

  // --- 全画面（発表のとき）-----------------------------------------------------
  // スライドと論文を並べた画面ごと全画面にする。見出しは隠れ、道具の帯は上の端にマウスを近づけたときだけ出る。
  const fsState = () =>
    page.evaluate(() => {
      const v = document.querySelector(".slides-view");
      const bar = document.querySelector(".sv-toolbar");
      return {
        native: document.fullscreenElement === v,
        fill: v.classList.contains("is-fill"),
        on: v.classList.contains("is-fullscreen"),
        heads: [...document.querySelectorAll(".sv-pane-head")].map((h) => getComputedStyle(h).display),
        bar: Number(getComputedStyle(bar).opacity),
      };
    });
  const waitBar = (shown) => page.waitForFunction((s) => Number(getComputedStyle(document.querySelector(".sv-toolbar")).opacity) === (s ? 1 : 0), shown);
  // 線の端（丸）が、どれかの四角とどれかのリンク先に付いているか。最後の段階では四角が 2 個になるので、上の linesAttached とは別に確かめる
  const linesOk = async () => {
    await page.waitForTimeout(500);
    const ok = await page.evaluate(() => {
      const svg = document.querySelector(".sv-lines").getBoundingClientRect();
      const near = (p, r) => p.x >= r.left - 3 && p.x <= r.right + 3 && p.y >= r.top - 3 && p.y <= r.bottom + 3;
      const boxes = [...document.querySelectorAll(".mu-box")].map((e) => e.getBoundingClientRect());
      const targets = [...document.querySelectorAll(".ln-anchor")].map((e) => e.getBoundingClientRect());
      return [...document.querySelectorAll(".sv-lines g")].flatMap((g) => {
        const cs = [...g.querySelectorAll("circle")].map((c) => ({ x: svg.left + +c.getAttribute("cx"), y: svg.top + +c.getAttribute("cy") }));
        return cs.length < 2 ? [] : [boxes.some((r) => near(cs[0], r)) && targets.some((t) => near(cs[1], t))];
      });
    });
    if (!ok.length || ok.includes(false)) fail(`線の端がずれています: ${JSON.stringify(ok)}`);
  };

  await step("全画面: 元の論文のスライドの画面に戻し、線を 1 本引いておく", async () => {
    await page.locator(".nav-file-title:not(.is-active)").first().click();
    await page.locator(".sv-slides .pp-page").nth(1).waitFor();
    await page.locator(".sv-paper .pp-page .textLayer span").first().waitFor();
    const deck = (await (await fetch(`${base}/api/papers/${id}/slides`)).json()).deck;
    const link = { id: "l-fs", kind: "figure", page: 1, rects: [{ x: 0.15, y: 0.3, w: 0.5, h: 0.1 }], text: "", createdAt: "" };
    await fetch(`${base}/api/papers/${id}/slides/markups`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-paperlens-client": "agent" },
      body: JSON.stringify({ ops: [{ op: "addLink", id: deck.markups[0].id, link }] }),
    });
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines circle").length === 2, null, { timeout: 5000 });
    await linesOk();
  });

  await step("全画面: ボタンで画面ごと全画面になり、見出しと道具の帯が隠れ、線は四角に付いたまま", async () => {
    await page.getByRole("button", { name: "全画面", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".slides-view").classList.contains("is-fullscreen"));
    const st = await fsState();
    if (!st.native && !st.fill) fail(`全画面になっていません: ${JSON.stringify(st)}`);
    console.log(st.native ? "  （Fullscreen API で全画面になりました）" : "  （このブラウザでは Fullscreen API が使えず、ウィンドウいっぱいの表示になりました）");
    if (st.heads.some((d) => d !== "none")) fail(`欄の見出しが出ています: ${JSON.stringify(st)}`);
    await page.locator(".sv-fs-hint", { hasText: "Esc で全画面を終えます" }).waitFor();
    // 押したボタンにフォーカスが残っていても、マウスが離れれば帯は隠れる
    await page.mouse.move(800, 600);
    await waitBar(false);
    await linesOk();
    const r = await page.locator(".slides-view").boundingBox();
    if (Math.round(r.width) !== 1600 || Math.round(r.height) !== 960) fail(`画面いっぱいになっていません: ${JSON.stringify(r)}`);
  });

  await step("全画面: 上の端にマウスを動かすと道具の帯が出て、止まると隠れる（線は動かない）", async () => {
    const before = await page.locator(".sv-lines circle").first().getAttribute("cy");
    await page.mouse.move(800, 10);
    await waitBar(true);
    if ((await page.locator(".sv-lines circle").first().getAttribute("cy")) !== before) fail("帯を出したら線が動きました");
    await linesOk();
    await page.screenshot({ path: path.join(shotDir, "slides-fullscreen.png") });
    await page.mouse.move(800, 500);
    await page.waitForTimeout(2300);
    await waitBar(false);
  });

  await step("全画面: 「全画面を終える」で戻り、見出しが出て、線は付いたまま", async () => {
    await page.mouse.move(800, 10);
    await waitBar(true);
    await page.getByRole("button", { name: "全画面を終える" }).click();
    await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector(".slides-view.is-fullscreen"));
    const st = await fsState();
    if (st.heads.some((d) => d === "none") || st.bar !== 1) fail(`元に戻っていません: ${JSON.stringify(st)}`);
    await linesOk();
  });

  await step("全画面: P キーでも切り替わり、全画面の中に知らせが出る", async () => {
    await page.mouse.move(800, 500);
    await page.keyboard.press("p");
    await page.waitForFunction(() => document.querySelector(".slides-view.is-fullscreen"));
    await linesOk();
    // 囲むと「…を作りました」の知らせが出る。全画面の要素の中に描かれていること
    await page.keyboard.press("r");
    const slide1 = await page.locator(".sv-slides .pp-page").first().boundingBox();
    await page.mouse.move(slide1.x + slide1.width * 0.1, slide1.y + slide1.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(slide1.x + slide1.width * 0.4, slide1.y + slide1.height * 0.8, { steps: 5 });
    await page.mouse.up();
    await page.locator(".snackbar", { hasText: "を作りました" }).waitFor();
    const inside = await page.evaluate(() => {
      const host = document.fullscreenElement ?? document.querySelector(".slides-view");
      const sn = document.querySelector(".snackbar");
      const r = sn.getBoundingClientRect();
      return host.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) || !document.fullscreenElement;
    });
    if (!inside) fail("知らせが全画面の中に見えていません");
    await page.keyboard.press("p");
    await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector(".slides-view.is-fullscreen"));
  });

  await step("全画面: 画面の外に描くモーダル（リスト）を開くと、全画面を終えて見えるようにする", async () => {
    await page.keyboard.press("p");
    await page.waitForFunction(() => document.querySelector(".slides-view.is-fullscreen"));
    await page.keyboard.press("Control+Shift+L");
    await page.getByRole("dialog", { name: "リスト" }).waitFor();
    await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector(".slides-view.is-fullscreen"));
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "リスト" }).waitFor({ state: "detached" });
  });

  await step("全画面: Fullscreen API が断られたときはウィンドウいっぱいに広げ、Esc は選択を外してから全画面を終える", async () => {
    await page.evaluate(() => {
      window.__rf = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = () => Promise.reject(new Error("denied"));
    });
    await page.keyboard.press("p");
    await page.waitForFunction(() => document.querySelector(".slides-view.is-fill"));
    const cover = await page.evaluate(() => {
      const v = document.querySelector(".slides-view");
      const r = v.getBoundingClientRect();
      const pts = [[5, 5], [innerWidth - 5, 5], [5, innerHeight - 5], [innerWidth - 5, innerHeight - 5]];
      return { r: [r.left, r.top, r.width, r.height], all: pts.every(([x, y]) => v.contains(document.elementFromPoint(x, y))) };
    });
    if (!cover.all || cover.r[0] !== 0 || cover.r[1] !== 0) fail(`ウィンドウを覆っていません: ${JSON.stringify(cover)}`);
    await linesOk();
    // 選んでいるグループがあるときの Esc は、まず選択を外す
    if (!(await page.locator('.mu-box[aria-pressed="true"]').count())) fail("グループが選ばれていません");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('.mu-box[aria-pressed="true"]'));
    await page.waitForTimeout(100);
    if (!(await page.locator(".slides-view.is-fill").count())) fail("選択を外す Esc で全画面まで終わりました");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".slides-view.is-fill, .slides-view.is-fullscreen"));
    await page.evaluate(() => {
      Element.prototype.requestFullscreen = window.__rf;
    });
    await linesOk();
  });

  if (errors.length) fail(`コンソールのエラー:\n${errors.join("\n")}`);
  console.log(`スクリーンショット: ${path.join(shotDir, "slides-split.png")}, ${path.join(shotDir, "slides-fullscreen.png")}`);
  console.log("papers:", readdirSync(path.join(data, "papers")).join(", "));
} finally {
  await browser?.close();
  server.kill();
}

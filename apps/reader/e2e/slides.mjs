// 発表スライドと論文の対応の画面の動作確認。先に npm run build を実行しておく。保存先は一時フォルダを使う。
//
// 1. 論文と 2 ページのスライドを API で取り込む
// 2. 画面で「囲む」を選び、スライドの 2 ページ目を囲む → Markup-02.01 ができる
// 3. 論文の文を選んで「文章としてリンク」、図を囲んでリンクする → 線が 2 本引かれる
// 4. slides.json と note.md に残ること、MCP の書き込みで線が増えることを確かめる
// 5. 全画面（発表の窓を開けないとき）: ボタンと P キーで入る・出る、見出しが隠れる、線がずれない、帯が上の端で出る、使えないときはウィンドウいっぱい
// 5'. 発表: 別の窓にスライドと論文を映し、元の窓に台本を出す。ページとグループの指示が窓の間で届く、閉じると元に戻る
// 6. 名前の札はカーソルを乗せたときだけ出ること、スライド側と Delete キーではグループごと、論文側ではそのリンクだけが消え、元に戻せること、
//    つまみで四角の大きさを直せること、消して空いた番号を次のグループが使うことを確かめる
// 7. 三面（スライド / 論文 / 補足情報）: タブと [ ] キーで横に送る、論文の幅は変わらない、隠れたスライドの線は引かない、補足情報から論文へ動かせる、
//    対訳で選んだ文に論文の面で枠が付く、選んだ側が残る
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
  // 初回の画面の案内（ツアー）が画面を覆わないようにする。案内は e2e/help.mjs で確かめる
  await page.addInitScript(() => { window.__PAPERLENS_NO_TOUR = true; });
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
    await page.locator('.mu-box[aria-pressed="true"][aria-label^="Markup-02.01"]').waitFor();
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

  // --- 名前の札と、グループを消す・元に戻す ---------------------------------
  const savedDeck = async (ok) => {
    let deck;
    for (let i = 0; i < 40; i++) {
      deck = JSON.parse(readFileSync(path.join(data, "papers", id, "slides.json"), "utf8"));
      if (ok(deck)) return deck;
      await new Promise((r) => setTimeout(r, 100));
    }
    return fail(`slides.json: ${JSON.stringify(deck)}`);
  };
  const visible = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].filter((e) => e.getClientRects().length > 0).length, sel);
  const gone = () =>
    page.waitForFunction(() =>
      [".mu-box", ".mu-tag", ".ln-anchor", ".ln-fill", ".ln-frame", ".ln-pin", ".sv-lines path.sv-line"].every((q) => !document.querySelector(q)),
    );
  const restoredAll = async () => {
    await page.locator('.mu-box[aria-label^="Markup-02.01"]').waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 2 && document.querySelectorAll(".ln-pin").length === 2);
    await savedDeck((d) => d.markups.length === 1 && d.markups[0].index === 1 && d.markups[0].links.length === 2);
  };

  await step("名前の札はふだん出ず、グループにカーソルを乗せると両側に出る（四角から札へ動かしても消えない）", async () => {
    await page.mouse.move(5, 5);
    if (await visible(".mu-tag")) fail("スライドの札がふだんから出ています");
    if (await visible(".ln-pin .ln-name")) fail("論文の札がふだんから出ています");
    if ((await visible(".ln-pin")) !== 2) fail("論文側の色の点がありません");
    // 点は小さく、文字をほとんど隠さない
    const dot = await page.locator(".ln-pin").first().boundingBox();
    if (dot.width > 14 || dot.height > 14) fail(`論文側の点が大きすぎます: ${JSON.stringify(dot)}`);
    await page.locator(".mu-box").hover();
    await page.locator(".mu-tag").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll(".ln-pin.is-hover .ln-name").length === 2);
    // 四角から札の消すボタンへ、少しずつ動かす
    const box = await page.locator(".mu-box").boundingBox();
    const del = await page.locator(".mu-tag .mu-del").boundingBox();
    await page.mouse.move(box.x + 20, box.y + 6);
    await page.mouse.move(del.x + del.width / 2, del.y + del.height / 2, { steps: 8 });
    if (!(await visible(".mu-tag .mu-del"))) fail("四角から札へ動かすと、札が消えました");
    await page.screenshot({ path: path.join(shotDir, "delete-hover.png") });
    // 論文側の点に乗ると、その場で札に広がる
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector(".ln-pin.is-hover"));
    await page.locator(".ln-pin").first().hover();
    await page.locator(".ln-pin").first().locator(".ln-name").waitFor({ state: "visible" });
    await page.locator(".mu-tag").waitFor({ state: "visible" });
    await page.mouse.move(5, 5);
  });

  await step("スライドの札の消すボタンで、四角・論文のリンク・線が消え、slides.json からもなくなる", async () => {
    await page.locator(".mu-box").hover();
    await page.getByRole("button", { name: "Markup-02.01 を消す（論文のリンク 2 件も消えます）" }).first().click();
    await gone();
    await page.locator(".sv-snack", { hasText: "Markup-02.01 を消しました（リンク 2 件も）" }).waitFor();
    if (await page.locator(".mp-item").count()) fail("右サイドバーにグループが残っています");
    await savedDeck((d) => d.markups.length === 0);
    const note = readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
    if (/### Markup-02\.01/.test(note)) fail(`note.md に残っています:\n${note}`);
  });

  await step("「元に戻す」で、同じ名前・同じリンクのまま戻る（消したのを保存したあとでも）", async () => {
    await page.locator(".sv-snack").getByRole("button", { name: "元に戻す" }).click();
    await restoredAll();
    await page.locator(".mp-item.is-active .mp-name", { hasText: "Markup-02.01" }).waitFor();
    if (await page.locator(".sv-snack").count()) fail("戻したあとも知らせが残っています");
    const note = await (async () => {
      for (let i = 0; i < 30; i++) {
        const n = readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
        if (/### Markup-02\.01/.test(n)) return n;
        await new Promise((r) => setTimeout(r, 100));
      }
      return "";
    })();
    if (!note) fail("note.md に戻っていません");
  });

  await step("論文側の点から消すと、そのリンクだけが外れ、スライドの四角ともう 1 本のリンクは残る。⌘Z（Ctrl+Z）で戻せる", async () => {
    await page.mouse.move(5, 5);
    await page.locator(".ln-pin").first().hover();
    await page.locator(".ln-pin").first().getByRole("button", { name: /^Markup-02\.01 から、この.+のリンクを外す/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".ln-pin").length === 1 && document.querySelectorAll(".sv-lines path.sv-line").length === 1);
    if (!(await page.locator('.mu-box[aria-label^="Markup-02.01"]').count())) fail("スライドの四角まで消えました");
    await page.locator(".sv-snack", { hasText: "Markup-02.01 から" }).waitFor();
    await savedDeck((d) => d.markups.length === 1 && d.markups[0].links.length === 1);
    // 保存したあとでも、同じリンクのまま戻る
    await page.mouse.move(5, 5);
    await page.keyboard.press("ControlOrMeta+z");
    await restoredAll();
  });

  await step("選んだグループの四角は、角のつまみで大きさを直せる（論文の図の囲みも）", async () => {
    await page.mouse.move(5, 5);
    if ((await page.locator(".mu-box").getAttribute("aria-pressed")) !== "true") await page.locator(".mu-box").click();
    const before = (await savedDeck(() => true)).markups[0];
    const h = await page.locator(".sv-slides .rz-se").boundingBox();
    if (!h) fail("スライドの四角につまみがありません");
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 60, h.y + 40, { steps: 6 });
    await page.mouse.up();
    const after = (await savedDeck((d) => d.markups[0].rect.w > before.rect.w + 0.01)).markups[0];
    if (Math.abs(after.rect.x - before.rect.x) > 1e-6 || Math.abs(after.rect.y - before.rect.y) > 1e-6) fail(`左上の角が動きました: ${JSON.stringify(after.rect)}`);
    if (after.index !== before.index || after.links.length !== 2) fail(`名前かリンクが変わりました: ${JSON.stringify(after)}`);
    // 論文側の図の囲みも、左上の角を内側へ寄せて小さくできる
    const fig = before.links.find((l) => l.kind === "figure");
    const fh = await page.locator(".sv-paper .rz-nw").boundingBox();
    if (!fh) fail("論文の図の囲みにつまみがありません");
    await page.mouse.move(fh.x + fh.width / 2, fh.y + fh.height / 2);
    await page.mouse.down();
    await page.mouse.move(fh.x + 20, fh.y + 20, { steps: 4 });
    await page.mouse.up();
    await savedDeck((d) => {
      const l = d.markups[0].links.find((x) => x.id === fig.id);
      return l && l.rects[0].x > fig.rects[0].x + 0.005 && l.rects[0].w < fig.rects[0].w;
    });
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 2);
  });

  await step("グループを選んで Delete を押すと消える", async () => {
    await page.mouse.move(5, 5);
    const pressed = await page.locator(".mu-box").getAttribute("aria-pressed");
    if (pressed !== "true") await page.locator(".mu-box").click();
    await page.locator('.mu-box[aria-pressed="true"]').waitFor();
    await page.keyboard.press("Delete");
    await gone();
    await savedDeck((d) => d.markups.length === 0);
    await page.locator(".sv-snack").getByRole("button", { name: "元に戻す" }).click();
    await restoredAll();
    await page.mouse.move(5, 5);
  });

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

  await step("最後の番号のグループを消して足し直すと、空いた番号（同じ名前）を使う", async () => {
    // 右サイドバーの消すボタンは 1 回押しで消す（元に戻せるため）
    await page.locator(".mp-item.is-active .mp-delete").click();
    await page.waitForFunction(() => !document.querySelector(".mu-box"));
    await page.keyboard.press("r");
    const slide2 = await page.locator(".sv-slides .pp-page").nth(1).boundingBox();
    await page.mouse.move(slide2.x + slide2.width * 0.1, slide2.y + slide2.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(slide2.x + slide2.width * 0.4, slide2.y + slide2.height * 0.7, { steps: 5 });
    await page.mouse.up();
    await page.locator('.mu-box[aria-label^="Markup-02.01"]').waitFor();
  });

  await step("メモを打ってすぐ別の論文を開いても、メモは保存される", async () => {
    // 前の段階の保存（少し待ってから送る）が終わってから読み直す
    for (let i = 0; i < 30; i++) {
      const d = JSON.parse(readFileSync(path.join(data, "papers", id, "slides.json"), "utf8"));
      // 消したグループと同じ名前（空いた番号）を使うので、リンクの無い新しいグループに替わったことで見分ける
      if (d.markups.length === 1 && d.markups[0].page === 2 && d.markups[0].index === 1 && !d.markups[0].links.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await fetch(`${base}/api/papers?name=other.pdf`, { method: "POST", body: sample });
    await page.reload();
    await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name: "発表スライドと論文の対応" }).click();
    await page.locator(".sv-slides .pp-page").first().waitFor();
    await page.locator(".mp-title", { hasText: "Markup-02.01" }).click();
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

  // --- 全画面（発表の窓を開けないとき）---------------------------------------------
  // 「発表」は別の窓を開くが、開けない（ポップアップを止められたなど）ときは、スライドと論文を並べた画面ごと全画面にする。
  // 見出しは隠れ、道具の帯は上の端にマウスを近づけたときだけ出る。ここでは window.open を止めて確かめる。
  const blockPopups = () =>
    page.evaluate(() => {
      window.__open ??= window.open;
      window.open = () => null;
    });
  const allowPopups = () =>
    page.evaluate(() => {
      if (window.__open) window.open = window.__open;
    });
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
    await blockPopups();
  });

  await step("全画面: 「発表」の窓を開けないときは、ボタンで画面ごと全画面になり、見出しと道具の帯が隠れ、線は四角に付いたまま", async () => {
    await page.getByRole("button", { name: "発表", exact: true }).click();
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

  await step("全画面: 全画面のままグループを消しても「元に戻す」が見え、⌘Z（Ctrl+Z）で戻る", async () => {
    await page.keyboard.press("p");
    await page.waitForFunction(() => document.querySelector(".slides-view.is-fullscreen"));
    const before = await page.locator(".mu-box").count();
    // 押すたびに選ぶ・外すが切り替わるので、選ばれた状態にしてから Delete を押す
    const box = page.locator(".mu-box").first();
    if ((await box.getAttribute("aria-pressed")) !== "true") await box.click();
    await page.waitForFunction(() => document.querySelector('.mu-box[aria-pressed="true"]'));
    await page.keyboard.press("Delete");
    await page.waitForFunction((n) => document.querySelectorAll(".mu-box").length === n - 1, before);
    await page.locator(".snackbar.sv-snack", { hasText: "を消しました" }).waitFor();
    const visible = await page.evaluate(() => {
      const r = document.querySelector(".snackbar.sv-snack").getBoundingClientRect();
      const host = document.fullscreenElement ?? document.querySelector(".slides-view");
      return host.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    if (!visible) fail("全画面の中で「元に戻す」が見えていません");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await page.waitForFunction((n) => document.querySelectorAll(".mu-box").length === n, before);
    if (!(await page.locator(".slides-view.is-fullscreen").count())) fail("元に戻したら全画面が終わりました");
    await linesOk();
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
    await allowPopups();
  });

  // --- 発表（別の窓と台本）---------------------------------------------------------
  // 「発表」で別の窓にスライドと論文を映し、元の窓にはグループのメモとリンクをスライドの順に台本として出す。
  let pop;
  const popErrors = [];
  const waitCurrent = (n) => page.waitForFunction((n) => document.querySelector(".sc-page.is-current")?.dataset.page === String(n), n, { timeout: 5000 });
  const openPresenter = async (how) => {
    [pop] = await Promise.all([page.waitForEvent("popup"), how()]);
    pop.on("console", (m) => m.type() === "error" && popErrors.push(m.text()));
    pop.on("pageerror", (e) => popErrors.push(String(e)));
    await pop.locator(".slides-view.is-fullscreen .sv-slides .pp-page").nth(1).waitFor();
    await page.locator(".sc").waitFor();
  };

  await step("発表: 「発表」で別の窓にスライドと論文が全画面で映り、元の窓には台本が出る", async () => {
    await page.mouse.move(800, 500);
    // 台本に出るメモを入れておく
    const deck = (await (await fetch(`${base}/api/papers/${id}/slides`)).json()).deck;
    const g = deck.markups.find((m) => m.links.length) ?? deck.markups[0];
    await fetch(`${base}/api/papers/${id}/slides/markups`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-paperlens-client": "agent" },
      body: JSON.stringify({ ops: [{ op: "update", id: g.id, patch: { memo: "ここで提案手法の要点を話す" } }] }),
    });
    await openPresenter(() => page.getByRole("button", { name: "発表", exact: true }).click());
    if (!(await pop.evaluate(() => new URL(location.href).searchParams.get("present")))) fail("発表の窓の URL に論文の ID がありません");
    if (await page.locator(".sv-split").count()) fail("元の窓にスライドと論文が残っています");
    const groups = await page.locator(".sc-group").count();
    if (groups !== deck.markups.length) fail(`台本のグループの数が違います: ${groups} / ${deck.markups.length}`);
    await page.locator(".sc-memo", { hasText: "ここで提案手法の要点を話す" }).waitFor();
    if (!(await page.locator(".sc-link").count())) fail("台本にリンク先が出ていません");
    await waitCurrent(1);
    await page.screenshot({ path: path.join(shotDir, "slides-script.png") });
    await pop.screenshot({ path: path.join(shotDir, "slides-presenter.png") });
  });

  await step("発表: 発表の窓で → を押すとスライドが進み、台本の印も進む。台本の ← で戻る", async () => {
    await pop.mouse.move(800, 500);
    await pop.keyboard.press("ArrowRight");
    await waitCurrent(2);
    await page.keyboard.press("ArrowLeft");
    await waitCurrent(1);
  });

  await step("発表: 台本でページの見出しを押すと、発表の窓がそのページへ動く", async () => {
    await page.locator('.sc-page[data-page="2"] .sc-page-head').click();
    await waitCurrent(2);
    // なめらかに動かすので、止まるのを待つ
    await pop
      .waitForFunction(() => {
        const s = document.querySelector(".sv-slides .pp-scroll").getBoundingClientRect();
        return Math.abs(document.querySelectorAll(".sv-slides .pp-page")[1].getBoundingClientRect().top - s.top) < 40;
      }, null, { timeout: 5000 })
      .catch(() => fail("発表の窓のスライドが 2 ページ目に動いていません"));
  });

  await step("発表: 台本でグループを押すと、発表の窓でそのグループが選ばれ、台本にも印が付く", async () => {
    const head = page.locator(".sc-group-head").first();
    const name = await head.locator(".sc-name").innerText();
    await head.click();
    await pop.locator(`.mu-box[aria-pressed="true"][aria-label^="${name}"]`).waitFor({ timeout: 5000 });
    await page.locator(".sc-group.is-active .sc-name", { hasText: name }).waitFor({ timeout: 5000 });
  });

  await step("発表: 「発表を終える」で発表の窓が閉じ、元の窓はスライドと論文の画面に戻る", async () => {
    await Promise.all([pop.waitForEvent("close"), page.getByRole("button", { name: "発表を終える" }).click()]);
    await page.locator(".sv-slides .pp-page").first().waitFor();
    if (await page.locator(".sc").count()) fail("台本が残っています");
  });

  await step("発表: P キーでも開き、発表の窓を閉じると元に戻る", async () => {
    await page.mouse.move(800, 500);
    await openPresenter(() => page.keyboard.press("p"));
    await pop.close();
    await page.locator(".sv-slides .pp-page").first().waitFor({ timeout: 5000 });
    if (await page.locator(".sc").count()) fail("発表の窓を閉じても台本が残っています");
    if (popErrors.length) fail(`発表の窓のコンソールのエラー:\n${popErrors.join("\n")}`);
  });

  // --- 三面（スライド / 論文 / 補足情報）-----------------------------------------
  // 見えるのはいつも二面だけ。[スライド | 論文] と [論文 | 補足情報] を横に送って切り替える。論文の幅は変わらない。
  const sideTab = (name) => page.getByRole("tab", { name, exact: true });
  const panes = () =>
    page.evaluate(() => {
      const v = document.querySelector(".sv-split").getBoundingClientRect();
      const r = (q) => {
        const e = document.querySelector(q);
        const b = e.getBoundingClientRect();
        // 画面に出ている幅（欄の枠の中で見える分）
        const shown = Math.max(0, Math.min(b.right, v.right) - Math.max(b.left, v.left));
        return { left: b.left, right: b.right, width: b.width, shown, inert: !!e.closest("[inert]") };
      };
      return {
        view: { left: v.left, right: v.right, width: v.width },
        slides: r(".sv-slides"),
        paper: r(".sv-paper"),
        info: r(".sv-info"),
        lines: document.querySelectorAll(".sv-lines path.sv-line").length,
        stored: (() => {
          try {
            return localStorage.getItem("paperlens.slides.side");
          } catch {
            return null;
          }
        })(),
      };
    });
  // 横送りが止まって、選んだ側がちょうど枠に収まるまで待つ
  const waitSide = (side) =>
    page.waitForFunction(
      (s) => {
        const v = document.querySelector(".sv-split").getBoundingClientRect();
        const pane = document.querySelector(s === "info" ? ".sv-info" : ".sv-slides").getBoundingClientRect();
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === (s === "info" ? "補足情報" : "スライド"));
        const fits = s === "info" ? Math.abs(pane.right - v.right) < 2 : Math.abs(pane.left - v.left) < 2;
        return fits && tab?.getAttribute("aria-selected") === "true";
      },
      side,
      { timeout: 5000 },
    );
  let paperWidth = 0;
  let lineCount = 0;

  await step("三面: 「スライド」「補足情報」のタブがあり、はじめはスライドの側が出ている", async () => {
    await page.mouse.move(800, 500);
    await sideTab("スライド").waitFor();
    await sideTab("補足情報").waitFor();
    if ((await sideTab("スライド").getAttribute("aria-selected")) !== "true") fail("はじめにスライドの側が選ばれていません");
    if ((await sideTab("補足情報").getAttribute("aria-selected")) !== "false") fail("補足情報のタブが選ばれています");
    await waitSide("slides");
    const st = await panes();
    if (st.slides.shown < st.slides.width - 2 || st.info.shown > 1) fail(`スライドの側になっていません: ${JSON.stringify(st)}`);
    if (!st.info.inert) fail("見えていない補足情報の欄が inert になっていません");
    if (st.slides.inert) fail("見えているスライドの欄が inert です");
    if (!st.lines) fail("線がありません");
    paperWidth = st.paper.width;
    lineCount = st.lines;
  });

  await step("三面: 「補足情報」を押すと、論文の右に補足情報が出て、スライドは隠れ、論文の幅は変わらない", async () => {
    await sideTab("補足情報").click();
    await waitSide("info");
    const st = await panes();
    if (st.slides.shown > 1) fail(`スライドが見えたままです: ${JSON.stringify(st)}`);
    if (st.paper.shown < st.paper.width - 2) fail(`論文が隠れています: ${JSON.stringify(st)}`);
    if (Math.abs(st.paper.width - paperWidth) > 2) fail(`論文の幅が変わりました: ${paperWidth} → ${st.paper.width}`);
    if (Math.abs(st.paper.left - st.view.left) > 2) fail(`論文が左の端に来ていません: ${JSON.stringify(st)}`);
    if (!st.slides.inert || st.info.inert) fail(`inert の付け方が違います: ${JSON.stringify(st)}`);
    if (st.stored !== "info") fail(`選んだ側が保存されていません: ${st.stored}`);
    // 補足情報の欄に、論文の画面の右サイドバーと同じタブ（訳・用語など）が出る
    const info = page.locator(".sv-info");
    await info.locator(".sv-pane-head", { hasText: "補足情報" }).waitFor();
    for (const name of ["訳", "用語", "数式", "記録"]) await info.getByRole("tab", { name: new RegExp(`^${name}`) }).waitFor();
  });

  await step("三面: スライドが隠れているあいだは線を引かず、戻すと元の本数で四角に付いている", async () => {
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 0, null, { timeout: 3000 });
    await page.screenshot({ path: path.join(shotDir, "slides-info.png") });
    await sideTab("スライド").click();
    await waitSide("slides");
    await page.waitForFunction((n) => document.querySelectorAll(".sv-lines path.sv-line").length === n, lineCount, { timeout: 3000 });
    await linesOk();
    const st = await panes();
    if (Math.abs(st.paper.width - paperWidth) > 2) fail(`論文の幅が変わりました: ${paperWidth} → ${st.paper.width}`);
    if (st.stored !== "slides") fail(`選んだ側が保存されていません: ${st.stored}`);
  });

  await step("三面: ] キーで補足情報へ、[ キーでスライドへ送る。入力欄の中では切り替わらない", async () => {
    await page.mouse.move(800, 500);
    await page.locator("body").evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("]");
    await waitSide("info");
    if ((await panes()).lines) fail("補足情報の側で線が出ています");
    // 用語の入力欄で [ を打っても、側は変わらない
    const info = page.locator(".sv-info");
    await info.getByRole("tab", { name: /^用語/ }).click();
    const input = info.getByPlaceholder("用語を入力");
    await input.click();
    await page.keyboard.type("[a]");
    await page.waitForTimeout(400);
    if ((await input.inputValue()) !== "[a]") fail(`入力欄に打った文字が入りません: ${await input.inputValue()}`);
    if ((await sideTab("補足情報").getAttribute("aria-selected")) !== "true") fail("入力欄で打った [ で側が変わりました");
    await input.fill("");
    await input.evaluate((e) => e.blur());
    await page.keyboard.press("[");
    await waitSide("slides");
    await page.waitForFunction((n) => document.querySelectorAll(".sv-lines path.sv-line").length === n, lineCount, { timeout: 3000 });
    await page.keyboard.press("]");
    await waitSide("info");
  });

  await step("三面: 補足情報の「訳」のページ番号を押すと、論文がそのページへ動く", async () => {
    // 2 ページ目のマーカーをほかの書き手として足す（画面に届く）
    const h = { id: "h-e2e", page: 2, rects: [{ x: 0.1, y: 0.3, w: 0.5, h: 0.02 }], text: "jump target", color: "yellow", translation: "", memo: "", createdAt: new Date().toISOString() };
    const res = await fetch(`${base}/api/papers/${id}/annotations`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-paperlens-client": "agent" },
      body: JSON.stringify({ ops: [{ op: "add", list: "highlights", item: h }] }),
    });
    if (!res.ok) fail(`マーカーを足せませんでした: ${await res.text()}`);
    const info = page.locator(".sv-info");
    await info.getByRole("tab", { name: /^訳/ }).click();
    const jump = info.getByRole("button", { name: "p.2", exact: true });
    await jump.waitFor({ timeout: 5000 });
    await page.evaluate(() => {
      document.querySelector(".sv-paper .pp-scroll").scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await jump.click();
    // 2 ページ目の 3 割あたり（マーカーの位置）が、論文の枠の中に見えている
    await page.waitForFunction(
      () => {
        const box = document.querySelector(".sv-paper .pp-scroll").getBoundingClientRect();
        const p2 = document.querySelectorAll(".sv-paper .pp-page")[1].getBoundingClientRect();
        const y = p2.top + p2.height * 0.3;
        return y >= box.top && y <= box.bottom;
      },
      null,
      { timeout: 5000 },
    );
    // 論文の面へ送ったあとも、補足情報の側のまま
    if ((await sideTab("補足情報").getAttribute("aria-selected")) !== "true") fail("ページへ動かしたら側が変わりました");
  });

  await step("三面: 補足情報の対訳で文を押すと、論文の面でその文に枠が付き、そこまで動く", async () => {
    const res = await fetch(`${base}/api/papers/${id}/sentences/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paperlens-client": "agent" },
      body: JSON.stringify({ parser: "fallback" }),
    });
    if (!res.ok) fail(`文に分けられませんでした: ${await res.text()}`);
    for (let i = 0; i < 100; i++) {
      const st = await (await fetch(`${base}/api/papers/${id}/sentences`)).json();
      if (st.status === "ready") break;
      if (st.status === "failed") fail(`解析に失敗しました: ${JSON.stringify(st)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const info = page.locator(".sv-info");
    await info.getByRole("tab", { name: /^対訳/ }).click();
    // 2 ページ目の文を選ぶ（論文の面を 1 ページ目の上に置いておき、動くことを確かめる）
    const card = info.locator("[data-sl-card]:not(.is-nonbody):not(.is-formula)").last();
    await card.waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      document.querySelector(".sv-paper .pp-scroll").scrollTop = 0;
    });
    await page.waitForTimeout(200);
    if (await page.locator(".sv-paper .sl-mark.is-active").count()) fail("選ぶ前から論文に文の枠があります");
    await card.click();
    await page.waitForFunction(
      () => {
        const box = document.querySelector(".sv-paper .pp-scroll").getBoundingClientRect();
        const marks = [...document.querySelectorAll(".sv-paper .sl-mark.is-active")];
        return marks.length > 0 && marks.some((m) => {
          const r = m.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom;
        });
      },
      null,
      { timeout: 5000 },
    );
    await page.screenshot({ path: path.join(shotDir, "slides-sentence.png") });
    if ((await sideTab("補足情報").getAttribute("aria-selected")) !== "true") fail("文を選んだら側が変わりました");
  });

  await step("三面: 補足情報の側のまま全画面にしても、論文と補足情報が並ぶ", async () => {
    await blockPopups();
    await page.mouse.move(800, 500);
    await page.keyboard.press("p");
    await page.waitForFunction(() => document.querySelector(".slides-view.is-fullscreen"));
    await waitSide("info");
    const st = await panes();
    if (st.slides.shown > 1 || st.paper.shown < st.paper.width - 2 || st.info.shown < st.info.width - 2) fail(`全画面での並びが違います: ${JSON.stringify(st)}`);
    // 全画面に入ると枠の大きさが変わるので、線を描き直すのを少し待つ
    await page
      .waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length === 0, null, { timeout: 3000 })
      .catch(() => fail("全画面の補足情報の側で線が出ています"));
    await page.keyboard.press("p");
    await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector(".slides-view.is-fullscreen"));
    await waitSide("info");
    await allowPopups();
  });

  await step("三面: 選んだ側は読み込み直しても残り、[ でスライドの側に戻す", async () => {
    await page.reload();
    await page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name: "発表スライドと論文の対応" }).click();
    await page.locator(".sv-slides .pp-page").first().waitFor();
    await page.locator(".sv-paper .pp-page .textLayer span").first().waitFor();
    await waitSide("info");
    const st = await panes();
    if (st.slides.shown > 1) fail(`読み込み直したらスライドの側に戻りました: ${JSON.stringify(st)}`);
    await page.mouse.move(800, 500);
    await page.keyboard.press("[");
    await waitSide("slides");
    if ((await panes()).stored !== "slides") fail("スライドの側が保存されていません");
    await page.waitForFunction(() => document.querySelectorAll(".sv-lines path.sv-line").length > 0, null, { timeout: 5000 });
    await linesOk();
  });

  if (errors.length) fail(`コンソールのエラー:\n${errors.join("\n")}`);
  console.log(`スクリーンショット: ${path.join(shotDir, "slides-split.png")}, ${path.join(shotDir, "slides-fullscreen.png")}, ${path.join(shotDir, "slides-info.png")}`);
  console.log("papers:", readdirSync(path.join(data, "papers")).join(", "));
} finally {
  await browser?.close();
  server.kill();
}

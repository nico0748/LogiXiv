// ヘルプと初回の画面の案内（ツアー）の動作確認。1 つの HTML ファイルにまとめた版（dist-single）で行う。
// 使い方: node e2e/help.mjs [画面写しの保存先]
// 別の場所に作った HTML を使うときは PL_HTML で指定する（例 PL_HTML=/tmp/build-help/index.html）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";

const html = readFileSync(process.env.PL_HTML ?? new URL("../dist-single/index.html", import.meta.url));
const port = Number(process.env.PL_PORT ?? 4341);
const server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); }).listen(port);
const shotDir = process.argv[2] ?? "/tmp/shots-help";
mkdirSync(shotDir, { recursive: true });
const base = `http://localhost:${port}/`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const fail = (msg) => { throw new Error(msg); };
const step = async (name, fn) => { await fn(); console.log("✓", name); };
// 開くときの動き（120〜140ms）が終わってから写す
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: `${shotDir}/${name}.png` }); };
const ribbon = (name) => page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name, exact: true });
const tour = page.locator(".tour-pop");
const tourCount = async () => (await page.locator(".tour-count").textContent())?.trim();
const helpTitle = page.locator("#help-page-title");
const setTheme = (t) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);

/** ブラウザ版の最初の画面から、サンプルの論文で開く */
const openSample = async () => {
  await page.getByRole("button", { name: "サンプルの論文で試す" }).click();
  await page.locator(".pdf-page[data-page='1'] .textLayer span").first().waitFor();
};
/** ツアーが出ないことを確かめる（自動で始めるまでの待ち時間より長く待つ） */
const expectNoTour = async (why) => {
  await page.waitForTimeout(1400);
  if (await tour.count()) fail(`ツアーが出ている: ${why}`);
};

await page.goto(base);

await step("初めて開くとツアーが始まる。リボンに更新情報の印が出る", async () => {
  await openSample();
  await tour.waitFor({ timeout: 5000 });
  if ((await tourCount()) !== "1 / 7") fail(`最初の手順ではない: ${await tourCount()}`);
  await page.getByRole("dialog", { name: "PaperLens へようこそ" }).waitFor();
  if (!(await page.locator(".ribbon .ribbon-badge").count())) fail("ヘルプに更新情報の印が無い");
  // 印があっても、リボンのボタンの名前は「ヘルプ」のまま
  await ribbon("ヘルプ").waitFor();
});

await step("→ / ← / 次へ / 戻る で手順を動かせる。各手順を写す（明るい表示）", async () => {
  await setTheme("light");
  for (let i = 1; i <= 7; i++) {
    if ((await tourCount()) !== `${i} / 7`) fail(`手順 ${i} ではない: ${await tourCount()}`);
    await page.waitForTimeout(350);
    await shot(`tour-${i}-light`);
    if (i < 7) await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("ArrowLeft");
  if ((await tourCount()) !== "6 / 7") fail("← で戻らない");
  await tour.getByRole("button", { name: "戻る" }).click();
  if ((await tourCount()) !== "5 / 7") fail("「戻る」で戻らない");
  await tour.getByRole("button", { name: "次へ" }).click();
  if ((await tourCount()) !== "6 / 7") fail("「次へ」で進まない");
});

await step("手順 2 では左サイドバーを開き、次の手順で元に戻す", async () => {
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  if ((await tourCount()) !== "2 / 7") fail("手順 2 に戻れない");
  await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") !== "true");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") === "true");
});

await step("Esc（あとで）で閉じる。同じタブで開き直しても、もう出ない", async () => {
  await page.keyboard.press("Escape");
  await tour.waitFor({ state: "detached" });
  // Esc はツアーだけが受け、ほかの画面には渡さない
  if (await page.locator(".modal").count()) fail("Esc でほかの画面が開いた");
  await page.reload();
  await openSample();
  await expectNoTour("「あとで」のあと");
  if (!(await page.locator(".ribbon .ribbon-badge").count())) fail("あとでを押しただけで更新情報の印が消えた");
});

await step("新しいタブ（あとでの記録なし）では再び出る。スキップすると次からは出ない", async () => {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await openSample();
  await tour.waitFor({ timeout: 5000 });
  await tour.getByRole("button", { name: "スキップ" }).click();
  await tour.waitFor({ state: "detached" });
  if (await page.locator(".ribbon .ribbon-badge").count()) fail("スキップしたのに更新情報の印が残っている");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await openSample();
  await expectNoTour("スキップのあと");
});

await step("ヘルプの「はじめに」からツアーを始め直し、最後まで進める", async () => {
  await ribbon("ヘルプ").click();
  await page.getByRole("dialog", { name: "ヘルプ" }).waitFor();
  if ((await helpTitle.textContent()) !== "はじめに") fail("ヘルプが「はじめに」で開かない");
  await page.getByRole("button", { name: "画面の案内（ツアー）をもう一度見る" }).click();
  await tour.waitFor();
  if (await page.getByRole("dialog", { name: "ヘルプ" }).count()) fail("ツアーを始めてもヘルプが閉じない");
  if ((await tourCount()) !== "1 / 7") fail("最初の手順から始まらない");
  for (let i = 0; i < 6; i++) await tour.getByRole("button", { name: "次へ" }).click();
  await tour.getByRole("button", { name: "はじめる" }).click();
  await tour.waitFor({ state: "detached" });
});

await step("ヘルプの章を写す（明るい表示）", async () => {
  await ribbon("ヘルプ").click();
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  await dlg.waitFor();
  await shot("help-start-light");
  for (const [label, file] of [["記録する", "help-record"], ["スライドと論文を対応させる", "help-slides"], ["キーボード操作", "help-keys"], ["更新情報", "help-changes"]]) {
    await dlg.getByRole("navigation", { name: "ヘルプの章" }).getByRole("button", { name: label }).click();
    await page.waitForTimeout(150);
    await shot(`${file}-light`);
  }
  await dlg.getByRole("button", { name: "よくある質問・困ったとき" }).click();
  await dlg.locator("#faq-ai summary").click();
  await shot("help-faq-light");
});

await step("ヘルプ内検索で章が見つかり、押すとその章を開く", async () => {
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  const box = dlg.getByRole("searchbox", { name: "ヘルプを検索" });
  await box.fill("BibTeX");
  const first = dlg.locator(".help-hit").first();
  await first.waitFor();
  if (!(await first.textContent()).includes("書き出す")) fail(`BibTeX の最初の当たりが「書き出す」ではない: ${await first.textContent()}`);
  await shot("help-search-light");
  await first.click();
  if (!(await helpTitle.textContent()).startsWith("書き出す")) fail("当たりを押しても章が開かない");
  // よくある質問の当たりは、その項目を開く
  await box.fill("API キー");
  await dlg.locator(".help-hit", { hasText: "よくある質問" }).first().click();
  await page.waitForFunction(() => document.querySelector("#faq-ai")?.hasAttribute("open"));
  // キーボード操作も当たる
  await box.fill("全画面");
  await dlg.locator(".help-keys-row").first().waitFor();
  // 語があるときの Esc は語を消すだけで、ヘルプは閉じない
  await box.press("Escape");
  if ((await box.inputValue()) !== "") fail("Esc で検索語が消えない");
  await dlg.waitFor();
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "detached" });
});

await step("? で早見表が開き、もう一度 ? か Esc で閉じる。入力中は開かない", async () => {
  await page.keyboard.press("Shift+Slash");
  const sheet = page.getByRole("dialog", { name: "キーボード操作の早見表" });
  await sheet.waitFor();
  if (!(await sheet.textContent()).includes("左サイドバー")) fail("早見表にショートカットが無い");
  await shot("keys-sheet-light");
  await page.keyboard.press("Shift+Slash");
  await sheet.waitFor({ state: "detached" });
  await page.keyboard.press("Shift+Slash");
  await sheet.waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  // 入力欄（右サイドバーのメモ）で ? を打っても開かない
  await ribbon("論文一覧").click();
  const search = page.getByPlaceholder("題名・著者・ノートを検索");
  await search.click();
  await page.keyboard.type("?");
  await page.waitForTimeout(200);
  if (await sheet.count()) fail("入力中に ? で早見表が開いた");
  if ((await search.inputValue()) !== "?") fail("入力欄に ? が入らない");
  await search.fill("");
});

await step("画面の各所の「?」から該当の章が開く（論文一覧・右サイドバー・スライドの画面）", async () => {
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  await page.getByRole("button", { name: "ヘルプ: 論文を取り込む・探す" }).click();
  await dlg.waitFor();
  if ((await helpTitle.textContent()) !== "論文を取り込む") fail(`論文一覧の ? で別の章: ${await helpTitle.textContent()}`);
  await page.keyboard.press("Escape");
  await ribbon("論文一覧").click();
  await page.getByRole("complementary", { name: "右サイドバー（補足情報）" }).getByRole("button", { name: /^ヘルプ: 記録する/ }).click();
  if (!(await helpTitle.textContent()).startsWith("記録する")) fail(`右サイドバーの ? で別の章: ${await helpTitle.textContent()}`);
  await page.keyboard.press("Escape");
  await ribbon("発表スライドと論文の対応").click();
  await page.getByRole("button", { name: "ヘルプ: スライドと論文を対応させる" }).click();
  if ((await helpTitle.textContent()) !== "スライドと論文を対応させる") fail("スライドの画面の ? で別の章");
  await page.keyboard.press("Escape");
  await ribbon("発表スライドと論文の対応").click();
});

await step("ヘルプの「API キーとモデルを設定する」で設定の該当ページが開く", async () => {
  await ribbon("ヘルプ").click();
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  await dlg.getByRole("navigation", { name: "ヘルプの章" }).getByRole("button", { name: "記録する" }).click();
  await dlg.getByRole("button", { name: "API キーとモデルを設定する" }).click();
  await page.getByRole("dialog", { name: "設定" }).waitFor();
  if (await dlg.count()) fail("設定を開いてもヘルプが残っている");
  await shot("help-to-settings-light");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "設定" }).waitFor({ state: "detached" });
});

await step("暗い表示で写す（ヘルプ・よくある質問・早見表・ツアー）", async () => {
  await setTheme("dark");
  await ribbon("ヘルプ").click();
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  await shot("help-start-dark");
  await dlg.getByRole("button", { name: "よくある質問・困ったとき" }).click();
  await dlg.locator("#faq-select summary").click();
  await shot("help-faq-dark");
  await dlg.getByRole("navigation", { name: "ヘルプの章" }).getByRole("button", { name: "キーボード操作" }).click();
  await shot("help-keys-dark");
  await dlg.getByRole("navigation", { name: "ヘルプの章" }).getByRole("button", { name: "はじめに" }).click();
  await page.getByRole("button", { name: "画面の案内（ツアー）をもう一度見る" }).click();
  for (let i = 1; i <= 7; i++) {
    await page.waitForTimeout(350);
    await shot(`tour-${i}-dark`);
    if (i < 7) await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Slash");
  await shot("keys-sheet-dark");
  await page.keyboard.press("Escape");
});

await step("狭い画面でもツアーとヘルプが崩れない", async () => {
  await setTheme("light");
  await page.setViewportSize({ width: 400, height: 820 });
  await ribbon("ヘルプ").click();
  await page.getByRole("button", { name: "画面の案内（ツアー）をもう一度見る" }).click();
  for (let i = 1; i <= 7; i++) {
    await page.waitForTimeout(350);
    const box = await tour.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > 400 || box.y < 0 || box.y + box.height > 820) fail(`手順 ${i} の吹き出しが画面からはみ出している: ${JSON.stringify(box)}`);
    if ([1, 2, 4].includes(i)) await shot(`tour-${i}-narrow`);
    if (i < 7) await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Escape");
  await ribbon("ヘルプ").click();
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  await dlg.getByRole("combobox").selectOption("faq");
  if ((await helpTitle.textContent()) !== "よくある質問・困ったとき") fail("狭い画面の章の選択欄で章が替わらない");
  await shot("help-faq-narrow");
  // 横にはみ出さない
  const over = await page.evaluate(() => [...document.querySelectorAll(".help-body *")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 1));
  if (over) fail("狭い画面でヘルプの中身が横にはみ出している");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
});

await browser.close();
server.close();
const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) {
  console.error("画面のエラー:", real);
  process.exit(1);
}
console.log("ヘルプとツアーの確認: すべて通りました");

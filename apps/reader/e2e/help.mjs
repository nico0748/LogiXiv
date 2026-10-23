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
// ブラウザ版の手順の数（対訳の手順は無い）
const N = 6;
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
  if ((await tourCount()) !== `1 / ${N}`) fail(`最初の手順ではない: ${await tourCount()}`);
  await page.getByRole("dialog", { name: "PaperLens へようこそ" }).waitFor();
  if (!(await tour.textContent()).includes("いま開いているのはブラウザ版です")) fail("どの版かを伝えていない");
  if (!(await page.locator(".ribbon .ribbon-badge").count())) fail("ヘルプに更新情報の印が無い");
  // 印があっても、リボンのボタンの名前は「ヘルプ」のまま
  await ribbon("ヘルプ").waitFor();
});

await step("→ / ← / 次へ / 戻る で手順を動かせる。各手順を写す（明るい表示）", async () => {
  await setTheme("light");
  for (let i = 1; i <= N; i++) {
    if ((await tourCount()) !== `${i} / ${N}`) fail(`手順 ${i} ではない: ${await tourCount()}`);
    await page.waitForTimeout(350);
    await shot(`tour-${i}-light`);
    if (i < N) await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("ArrowLeft");
  if ((await tourCount()) !== `${N - 1} / ${N}`) fail("← で戻らない");
  await tour.getByRole("button", { name: "戻る" }).click();
  if ((await tourCount()) !== `${N - 2} / ${N}`) fail("「戻る」で戻らない");
  await tour.getByRole("button", { name: "次へ" }).click();
  if ((await tourCount()) !== `${N - 1} / ${N}`) fail("「次へ」で進まない");
});

await step("手順 2 では左サイドバーを開き、次の手順で元に戻す", async () => {
  for (let i = 0; i < N - 3; i++) await page.keyboard.press("ArrowLeft");
  if ((await tourCount()) !== `2 / ${N}`) fail("手順 2 に戻れない");
  await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") !== "true");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") === "true");
});

await step("ツアーの間は Tab が吹き出しの中を回り、? などほかのキー操作は効かない", async () => {
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => !!document.activeElement?.closest(".tour-pop")))) fail("Tab で吹き出しの外へ出た");
  }
  await page.keyboard.press("Shift+Tab");
  if (!(await page.evaluate(() => !!document.activeElement?.closest(".tour-pop")))) fail("Shift+Tab で吹き出しの外へ出た");
  await page.keyboard.press("Shift+Slash");
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(200);
  if (await page.getByRole("dialog", { name: "キーボード操作の早見表" }).count()) fail("ツアーの間に ? で早見表が開いた");
  if ((await page.locator("aside.sidebar.left").getAttribute("aria-hidden")) !== "true") fail("ツアーの間に Ctrl+\\ が効いた");
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
  if ((await tourCount()) !== `1 / ${N}`) fail("最初の手順から始まらない");
  for (let i = 0; i < N - 1; i++) await tour.getByRole("button", { name: "次へ" }).click();
  await tour.getByRole("button", { name: "使いはじめる" }).click();
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
  // 初めて使う人の言い方でも当たる（言い換えと、空白の有無）
  for (const [q, want] of [["訳せない", "訳"], ["保存場所", "ノートはどこ"], ["翻訳", "記録する"], ["ダークモード", "設定"], ["バックアップ", "別の PC"], ["料金", "お金"], ["PDFが表示されない", "PDF が表示されない"], ["APIキー", "訳が入らない"], ["ショートカット", "キーボード操作"]]) {
    await box.fill(q);
    await dlg.locator(".help-hit").first().waitFor();
    const titles = await dlg.locator(".help-hit-title").allTextContents();
    if (!titles.slice(0, 3).some((t) => t.includes(want))) fail(`『${q}』の上位 3 件に「${want}」が無い: ${titles.join(" / ")}`);
  }
  await box.fill("料金");
  await dlg.locator(".help-hit").first().click();
  await page.waitForFunction(() => document.querySelector("#faq-cost")?.hasAttribute("open"));
  await shot("help-faq-cost-light");
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

await step("設定を開いているとき ? は何もしない。設定の「?」から開いたヘルプは、閉じると設定に戻る", async () => {
  await ribbon("設定").click();
  const settings = page.getByRole("dialog", { name: "設定" });
  await settings.waitFor();
  await page.keyboard.press("Shift+Slash");
  await page.waitForTimeout(200);
  if (await page.getByRole("dialog", { name: "キーボード操作の早見表" }).count()) fail("設定の上で ? が早見表を開いた");
  await settings.waitFor();
  // 既定（全般）でないページから開き、戻ったときに同じページと検索の語が残っていることを確かめる
  await settings.getByRole("navigation", { name: "設定の項目" }).getByRole("button", { name: "読解と AI" }).click();
  await settings.getByRole("heading", { level: 2, name: "読解と AI" }).waitFor();
  await settings.getByRole("searchbox", { name: "設定を検索" }).fill("モデル");
  await settings.locator(".settings-page-header .help-button").click();
  const dlg = page.getByRole("dialog", { name: "ヘルプ" });
  await dlg.waitFor();
  await page.keyboard.press("Escape");
  await settings.getByRole("heading", { level: 2, name: "読解と AI" }).waitFor();
  if ((await settings.getByRole("searchbox", { name: "設定を検索" }).inputValue()) !== "モデル") fail("ヘルプから戻ると検索の語が消える");
  await settings.getByRole("searchbox", { name: "設定を検索" }).fill("");
  await settings.locator(".settings-page-header .help-button").click();
  await dlg.getByRole("button", { name: "閉じる" }).click();
  await settings.getByRole("heading", { level: 2, name: "読解と AI" }).waitFor();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
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
  for (let i = 1; i <= N; i++) {
    await page.waitForTimeout(350);
    await shot(`tour-${i}-dark`);
    if (i < N) await page.keyboard.press("ArrowRight");
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
  for (let i = 1; i <= N; i++) {
    await page.waitForTimeout(350);
    const box = await tour.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > 400 || box.y < 0 || box.y + box.height > 820) fail(`手順 ${i} の吹き出しが画面からはみ出している: ${JSON.stringify(box)}`);
    if (i === 3) {
      // 「文を選んで記録する」では、中央に重なるサイドバーを両方閉じて PDF を見せる
      const hidden = await page.evaluate(() => ["left", "right"].map((x) => document.querySelector(`aside.sidebar.${x}`)?.getAttribute("aria-hidden")));
      if (hidden.some((h) => h !== "true")) fail(`狭い画面の手順 3 でサイドバーが開いている: ${hidden}`);
    }
    await shot(`tour-${i}-narrow`);
    if (i < N) await page.keyboard.press("ArrowRight");
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

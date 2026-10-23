// 設定の画面の動作確認（ページの切り替え・設定内の検索・表示の設定の反映）。ヘッドレス Chromium で動かす。
// 1 ファイル版を使う。PL_HTML で HTML の場所を替えられる（既定は dist-single/index.html）。
// 引数でスクリーンショットの置き場を指定すると、各ページを明暗両方で撮る。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";

const html = readFileSync(process.env.PL_HTML ?? new URL("../dist-single/index.html", import.meta.url));
const server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); }).listen(4331);
const shotDir = process.argv[2];
if (shotDir) mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, colorScheme: "light" });
// 初回の画面の案内（ツアー）を出さない
await page.addInitScript(() => { window.__PAPERLENS_NO_TOUR = true; });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

// 「接続を確かめる」の Models API は偽の応答に差し替える
await page.route("https://api.anthropic.com/**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }),
  }),
);

const step = async (name, fn) => { await fn(); console.log("✓", name); };
const ribbon = (name) => page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name, exact: true });
const modal = page.getByRole("dialog", { name: "設定" });
const nav = modal.getByRole("navigation", { name: "設定の項目" });
const pageTitle = () => modal.locator(".settings-page-title").textContent();
// 1 ファイル版は読み直すと最初の画面に戻るので、もう一度サンプルで開く
const reopen = async () => {
  await page.reload();
  await page.getByRole("button", { name: "サンプルの論文で試す" }).click();
  await page.locator(".pdf-page[data-page='1'] .textLayer span").first().waitFor();
};
const openPage = async (label) => {
  // 保存していない変更があるページは、名前の後ろに知らせが付く
  await nav.getByRole("button", { name: new RegExp(`^${label.replace(/[()（）]/g, "\\$&")}`) }).click();
  await modal.getByRole("heading", { level: 2, name: label }).waitFor();
};

try {
  await page.goto("http://localhost:4331/");
  await step("サンプルで開く", async () => {
    await page.getByRole("button", { name: "サンプルの論文で試す" }).click();
    await page.locator(".pdf-page[data-page='1'] .textLayer span").first().waitFor();
  });

  await step("設定を開くと「全般」だけを出す", async () => {
    await ribbon("設定").click();
    await modal.waitFor();
    if ((await pageTitle()) !== "全般") throw new Error(`最初のページが違う: ${await pageTitle()}`);
    if ((await modal.locator(".settings-page").count()) !== 1) throw new Error("ページが 1 つだけでない");
    await modal.getByText("起動時の動作").waitFor();
    if (await modal.getByText("API キー", { exact: true }).count()) throw new Error("ほかのページの項目が出ている");
  });

  await step("ナビでページを切り替える", async () => {
    for (const label of ["表示", "読解と AI", "テンプレート", "データ", "AI エージェント（MCP）", "Obsidian", "ショートカット", "このアプリについて", "全般"]) {
      await openPage(label);
      const cur = await nav.locator("[aria-current='page']").textContent();
      if (cur !== label) throw new Error(`ナビの選択が違う: ${cur}`);
    }
  });

  await step("設定内の検索から該当のページと項目へ移る", async () => {
    const search = modal.getByRole("searchbox", { name: "設定を検索" });
    await search.fill("行間");
    const results = modal.getByRole("list", { name: "検索の結果" });
    await results.getByRole("listitem").first().waitFor();
    await results.getByRole("listitem").filter({ hasText: "行間" }).first().click();
    await modal.getByRole("heading", { level: 2, name: "表示" }).waitFor();
    await modal.locator("#set-leading.is-flash").waitFor();
    // 当てはまらない語
    await search.fill("ぜんぜんない語");
    await modal.getByText("当てはまる設定はありません。").waitFor();
    // Enter で先頭の結果へ。Esc は語を消すだけで、設定は閉じない
    await search.fill("API キー");
    await search.press("Enter");
    await modal.getByRole("heading", { level: 2, name: "読解と AI" }).waitFor();
    await search.press("Escape");
    if ((await search.inputValue()) !== "") throw new Error("Esc で語が消えない");
    await modal.waitFor();
    await nav.getByRole("button", { name: "表示", exact: true }).waitFor();
  });

  await step("テーマを替えると、すぐに画面に映り、読み直しても残る", async () => {
    await openPage("表示");
    await modal.getByRole("radiogroup", { name: "テーマ" }).getByRole("radio", { name: "ダーク" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (bg !== "rgb(19, 19, 24)") throw new Error(`暗い表示の背景にならない: ${bg}`);
    await modal.getByRole("radiogroup", { name: "テーマ" }).getByRole("radio", { name: "システム" }).click();
    // 端末の設定（ライト）に合わせる
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await modal.getByRole("radiogroup", { name: "テーマ" }).getByRole("radio", { name: "ダーク" }).click();
    await reopen();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    // 右上のボタンでも替えられ、設定と同じ値になる
    await page.getByRole("button", { name: "明るい表示にする" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await ribbon("設定").click();
    await openPage("表示");
    const checked = await modal.getByRole("radiogroup", { name: "テーマ" }).getByRole("radio", { checked: true }).textContent();
    if (checked !== "ライト") throw new Error(`設定の表示が合わない: ${checked}`);
  });

  await step("文字の大きさを替えると、右サイドバーの文字が大きくなる", async () => {
    const size = () => page.evaluate(() => getComputedStyle(document.querySelector(".panel") ?? document.body).getPropertyValue("--font-ui-small").trim());
    const before = await size();
    await modal.getByLabel("補足情報の文字サイズ").fill("17");
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--pl-fs-body").startsWith("1.3"));
    const px = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".panel .panel-note") ?? document.querySelector(".panel")).fontSize));
    if (!(px > 14)) throw new Error(`本文の文字が大きくならない: ${before} → ${px}px`);
    // アクセント色
    await modal.getByRole("radiogroup", { name: "アクセント色" }).getByRole("radio", { name: "緑" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.accent === "green");
  });

  await step("API キーを入力すると「未確認」になり、確かめると結果を出す", async () => {
    await openPage("読解と AI");
    await modal.getByText("API キーはまだ設定していません。").waitFor();
    await modal.getByRole("link", { name: "Anthropic Console" }).waitFor();
    await modal.getByLabel("API キー", { exact: true }).fill("sk-ant-test");
    await modal.getByText("保存しました（未確認）", { exact: false }).waitFor();
    await modal.getByRole("button", { name: "接続を確かめる" }).click();
    await modal.getByText("接続できました（Claude Opus 5.5）。").waitFor();
    await modal.getByText("API キーを確かめました。使えます。").waitFor();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("paperlens.ai")));
    if (stored.apiKey !== "sk-ant-test") throw new Error("API キーが保存されない");
  });

  await step("訳語の欄を空にしても行は消えず、空白も打てる", async () => {
    await modal.getByLabel("英語の語").fill("self-attention");
    await modal.getByLabel("訳語", { exact: true }).fill("自己注意");
    await modal.getByRole("button", { name: "足す" }).click();
    const row = modal.getByLabel("self-attention の訳語");
    await row.fill("");
    await row.pressSequentially("自己 注意");
    if ((await row.inputValue()) !== "自己 注意") throw new Error(`訳語に空白が打てない: ${await row.inputValue()}`);
    await row.fill("");
    if (!(await modal.getByLabel("self-attention の訳語").count())) throw new Error("訳語を空にすると行が消える");
    await modal.getByRole("button", { name: "self-attention を消す" }).click();
  });

  await step("保存していないテンプレートは、ページを替えても残る", async () => {
    await openPage("テンプレート");
    const tpl = modal.locator("#tpl");
    await page.waitForFunction(() => !document.querySelector("#tpl")?.disabled);
    await tpl.press("Control+End");
    await tpl.pressSequentially("\n追記のテスト");
    await modal.getByText("保存していない変更があります").first().waitFor();
    await openPage("表示");
    await openPage("テンプレート");
    if (!(await tpl.inputValue()).endsWith("追記のテスト")) throw new Error("下書きが消えた");
    // 設定を閉じて開き直しても残り、ナビに印が付いている
    await modal.getByRole("button", { name: "閉じる" }).click();
    await modal.waitFor({ state: "detached" });
    await ribbon("設定").click();
    await nav.locator(".nav-dot").waitFor();
    await openPage("テンプレート");
    await page.waitForFunction(() => document.querySelector("#tpl")?.value.endsWith("追記のテスト"));
    await modal.getByRole("button", { name: "変更を取り消す" }).click();
    await nav.locator(".nav-dot").waitFor({ state: "detached" });
  });

  await step("画面の配置のリセットは、読み直さずにその場で戻し、閉じたあとも戻ったまま", async () => {
    await modal.getByRole("button", { name: "閉じる" }).click();
    await page.keyboard.press("Control+Backslash");
    await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") !== "true");
    await ribbon("設定").click();
    await openPage("データ");
    await modal.locator("#set-reset").getByRole("button", { name: "初期に戻す" }).nth(1).click();
    await modal.getByRole("button", { name: "戻す", exact: true }).click();
    await modal.getByText("画面の配置を初期に戻しました。").waitFor();
    await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") === "true");
    // お試しの保管庫のまま（最初の画面に戻らない）
    await page.locator(".pdf-page[data-page='1']").first().waitFor();
    // 閉じるときの保存（pagehide）でも古い配置を書き戻さない
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    const saved = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("paperlens.workspace.")).map(([, v]) => JSON.parse(v)));
    if (saved.some((w) => w.leftOpen)) throw new Error(`古い配置が残っている: ${JSON.stringify(saved)}`);
  });

  await step("ショートカットを検索できる", async () => {
    await openPage("ショートカット");
    const before = await modal.locator(".shortcut-row").count();
    await modal.getByLabel("ショートカットを検索").fill("全画面");
    const after = await modal.locator(".shortcut-row").count();
    if (!(after >= 1 && after < before)) throw new Error(`絞り込まれない: ${before} → ${after}`);
    await modal.getByLabel("ショートカットを検索").fill("");
  });

  await step("右サイドバーの「API キーを設定する」から AI のページが開く", async () => {
    await page.evaluate(() => {
      const ai = JSON.parse(localStorage.getItem("paperlens.ai"));
      localStorage.setItem("paperlens.ai", JSON.stringify({ ...ai, apiKey: "" }));
    });
    await reopen();
    await page.getByRole("button", { name: "API キーを設定する" }).first().click();
    await modal.getByRole("heading", { level: 2, name: "読解と AI" }).waitFor();
    await modal.locator("#set-api-key").waitFor();
    // 閉じてリボンから開き直すと「全般」から
    await modal.getByRole("button", { name: "閉じる" }).click();
    await ribbon("設定").click();
    await modal.getByRole("heading", { level: 2, name: "全般" }).waitFor();
    await modal.getByRole("button", { name: "閉じる" }).click();
  });

  if (shotDir) {
    await step("各ページを明暗両方で撮る", async () => {
      const labels = { general: "全般", display: "表示", ai: "読解と AI", template: "テンプレート", data: "データ", mcp: "AI エージェント（MCP）", obsidian: "Obsidian", shortcuts: "ショートカット", about: "このアプリについて" };
      await page.evaluate(() => localStorage.setItem("paperlens.accent", "indigo"));
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => localStorage.setItem("paperlens.theme", t), theme);
        await reopen();
        await ribbon("設定").click();
        for (const [id, label] of Object.entries(labels)) {
          await openPage(label);
          await page.waitForTimeout(150);
          await page.screenshot({ path: `${shotDir}/${theme}-${id}.png` });
        }
        await modal.getByRole("searchbox", { name: "設定を検索" }).fill("文字");
        await page.screenshot({ path: `${shotDir}/${theme}-search.png` });
        await modal.getByRole("button", { name: "閉じる" }).click();
      }
      // 狭い画面（800px は左に細いナビ、420px は上にタブ）
      for (const w of [800, 420]) {
        await page.setViewportSize({ width: w, height: 800 });
        await ribbon("設定").click();
        await openPage("表示");
        await page.screenshot({ path: `${shotDir}/narrow-${w}-display.png` });
        await openPage("読解と AI");
        await page.screenshot({ path: `${shotDir}/narrow-${w}-ai.png` });
        await modal.getByRole("button", { name: "閉じる" }).click();
      }
    });
  }

  if (errors.length) throw new Error(`コンソールのエラー:\n${errors.join("\n")}`);
  console.log("設定の確認: すべて通りました");
} finally {
  await browser.close();
  server.close();
}

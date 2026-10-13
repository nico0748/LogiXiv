// ローカルサーバー版と MCP サーバーの動作確認。
// 先に npm run build を実行しておく。保存先は一時フォルダを使う。
//
// 1. 画面から PDF を取り込み、マーカーと記録を入れる
// 2. 同じ保存先に MCP サーバーをつなぎ、AI エージェントとしてマーカー・用語・記録を書き込む
// 3. 画面を読み直さずに、エージェントの変更が映り、画面の変更も消えていないことを確かめる
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = mkdtempSync(path.join(tmpdir(), "paperlens-e2e-"));
const shotDir = process.argv[2] ?? tmpdir();
const env = { ...process.env, PAPERLENS_DATA: data, PAPERLENS_PORT: "5297", PAPERLENS_ALLOW_PRIVATE_URLS: "1" };
// URL からの取り込みは、このサーバー自身が返す PDF で確かめる（外へは通信しない）

const server = spawn(process.execPath, [path.join(root, "dist-server/server.js")], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (b) => String(b).includes("起動しました") && resolve());
  server.on("exit", (c) => reject(new Error(`サーバーが止まりました（${c}）`)));
});

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const step = async (name, fn) => { await fn(); console.log("✓", name); };
// 左端のリボンのボタン（論文一覧・検索・リスト・グラフ・設定・ヘルプ）
const ribbon = (name) => page.getByRole("navigation", { name: "主要メニュー" }).getByRole("button", { name, exact: true });
// 左サイドバーは最初は閉じている。⌘/Ctrl+\ で開く
const openLeft = async () => {
  if ((await page.locator("aside.sidebar.left").getAttribute("aria-hidden")) !== "true") return;
  // 配置（/api/workspace）の読み込みが終わる前に押すと、読み込んだ配置で閉じ直されることがあるので、開くまで押し直す
  await page.getByRole("navigation", { name: "主要メニュー" }).waitFor();
  for (let i = 0; ; i++) {
    await page.keyboard.press("Control+Backslash");
    const ok = await page.waitForFunction(() => document.querySelector("aside.sidebar.left")?.getAttribute("aria-hidden") !== "true", null, { timeout: 2000 }).then(() => true, () => false);
    if (ok) await page.waitForTimeout(300);
    if (ok && (await page.locator("aside.sidebar.left").getAttribute("aria-hidden")) !== "true") return;
    if (i >= 4) throw new Error("⌘/Ctrl+\\ で左サイドバーが開かない");
  }
};
// 右サイドバーのタブ。「訳」は「対訳」と区別するため先頭で合わせる
const rightTab = (name) => page.getByRole("tablist", { name: "補足情報" }).getByRole("tab", { name: new RegExp(`^${name}`) });
const done = async (code) => { await browser.close(); server.kill(); process.exit(code); };
process.on("unhandledRejection", async (e) => { console.error(e); await done(1); });
// 途中で失敗して終わったときも、サーバーを残さない
process.on("exit", () => server.kill());

// 画面の配置（サイドバーの開閉）はサーバーから読み込む。読み込み終わってから操作する
const workspaceLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/workspace" && r.request().method() === "GET");
await page.goto("http://127.0.0.1:5297/");
await workspaceLoaded;

await step("サーバーの保存先で開く", async () => {
  await openLeft();
  await page.getByText("論文はまだありません").waitFor();
  const crumb = await page.locator(".sidebar-vault-name").textContent();
  if (!crumb.includes(path.basename(data))) throw new Error(`保存先の名前が出ていない: ${crumb}`);
  const bar = await page.locator(".status-bar").textContent();
  if (!bar.includes(path.basename(data))) throw new Error(`状態表示に保存先の名前が出ていない: ${bar}`);
  // サーバー版の追加ボタンはメニュー（PDF ファイル / URL）を開く
  const add = page.getByRole("button", { name: "論文を追加", exact: true });
  if ((await add.getAttribute("aria-haspopup")) !== "menu") throw new Error("「論文を追加」がメニューを開くボタンでない");
  await add.click();
  await page.getByRole("menuitem", { name: "PDF ファイルを選ぶ" }).waitFor();
  await page.getByRole("menuitem", { name: "URL から追加" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "論文を追加" }).waitFor({ state: "detached" });
});

await step("PDF を取り込む", async () => {
  await page.locator("input[type=file]").setInputFiles(path.join(root, "src/demo/sample.pdf"));
  await page.locator(".pdf-page[data-page='1'] .textLayer span").first().waitFor();
  await page.waitForTimeout(600);
});
const id = readdirSync(path.join(data, "papers"))[0];

await step("画面でマーカーと記録を入れる", async () => {
  await page.evaluate(() => {
    const a = [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.includes("We propose"));
    const r = document.createRange();
    const i = a.textContent.indexOf("We propose");
    r.setStart(a.firstChild, i);
    r.setEnd(a.firstChild, Math.min(a.textContent.length, i + 30));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.querySelector(".pdf-scroll").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator(".sel-menu").waitFor({ timeout: 5000 }).catch(async (e) => {
    await page.screenshot({ path: `${shotDir}/10-fail.png` });
    console.error(await page.evaluate(() => [getSelection().toString(), document.querySelectorAll(".textLayer span").length]));
    throw e;
  });
  await page.getByRole("button", { name: "緑色のマーカーを引く" }).click();
  await page.locator(".mk.green").first().waitFor();
  await rightTab("記録").click();
  await page.getByLabel("一言でいうと").fill("画面から書いた要約。");
  await page.waitForTimeout(1200);
  const md = readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
  if (!md.includes("画面から書いた要約。")) throw new Error("記録が note.md に入っていない");
});

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp.js")], env, stderr: "ignore" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};

await step("MCP: ツールの一覧", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const want of ["list_papers", "read_paper_text", "add_highlight", "add_term", "add_equation", "set_fields", "set_status", "import_paper"]) {
    if (!names.includes(want)) throw new Error(`${want} が無い`);
  }
  const papers = JSON.parse(await call("list_papers"));
  if (papers[0]?.id !== id) throw new Error("論文が見えていない");
  if (!(await call("read_paper_text", { paper: id, to_page: 1 })).includes("Transformer models struggle")) throw new Error("本文が読めない");
});

await step("MCP: エージェントが書き込む", async () => {
  const h = JSON.parse(await call("add_highlight", { paper: id, text: "Transformer models struggle to read long scientific documents", color: "cyan", translation: "Transformer は長い学術文書を読むのが苦手である。" }));
  if (!h.located) throw new Error("本文の位置が見つかっていない");
  await call("add_term", { paper: id, term: "疎な窓付き注意（sparse window attention）", short: "各トークンが近くの窓の中だけに注意を向ける仕組み。", related: ["自己注意"] });
  await call("add_equation", { paper: id, tex: "O(n \\cdot w)", explanation: "計算量。n は系列長、w は窓の幅。" });
  await call("set_fields", { paper: id, values: { purpose: "エージェントが書いた読む目的。" } });
  await call("set_status", { paper: id, status: "精読" });
});

await step("画面に、読み直さずに反映される", async () => {
  await page.locator(".mk.cyan").first().waitFor({ timeout: 5000 }).catch(async (e) => {
    await page.screenshot({ path: `${shotDir}/10-fail.png` });
    console.error(await page.locator(".tabs").textContent(), await page.locator(".mk").count());
    throw e;
  });
  await page.getByLabel("読む目的").and(page.locator("textarea")).waitFor();
  await page.waitForFunction(() => document.querySelector("#f-purpose")?.value === "エージェントが書いた読む目的。", null, { timeout: 5000 });
  await page.locator(".nav-file-title .tag", { hasText: "精読" }).waitFor({ timeout: 5000 });
  if ((await page.locator("#f-summary").inputValue()) !== "画面から書いた要約。") throw new Error("画面で書いた記録が消えた");
  if ((await page.locator(".mk.green").count()) === 0) throw new Error("画面で引いたマーカーが消えた");
  await rightTab("訳").click();
  await page.getByText("Transformer は長い学術文書を読むのが苦手である。").waitFor();
  await page.screenshot({ path: `${shotDir}/11-mcp-live.png` });
  await rightTab("用語").click();
  await page.getByText("各トークンが近くの窓の中だけに").waitFor();
});

await step("画面の変更をエージェントが読める", async () => {
  await rightTab("訳").click();
  await page.locator(".card", { hasText: "We propose" }).locator("textarea.trans").fill("画面で付けた訳。");
  await page.waitForTimeout(1200);
  const p = JSON.parse(await call("get_paper", { paper: id }));
  if (!p.annotations.highlights.some((h) => h.translation === "画面で付けた訳。")) throw new Error("画面の訳がエージェントから見えない");
  if (p.annotations.highlights.length !== 2) throw new Error(`マーカーの数が違う: ${p.annotations.highlights.length}`);
});

await step("対訳タブを開く", async () => {
  await rightTab("対訳").click();
  const panel = page.locator("#panel-sentences");
  await panel.waitFor();
  // 解析が終わるか、状態（解析中・失敗）の表示が出るまで待つ
  await page.waitForFunction(() => {
    const el = document.querySelector("#panel-sentences");
    return el && el.textContent.trim().length > 0 && !el.querySelector("[aria-busy='true']");
  }, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotDir}/16-sentences.png` });
  await rightTab("訳").click();
});

await step("設定画面に MCP の登録方法が出る", async () => {
  await ribbon("設定").click();
  await page.getByRole("dialog", { name: "設定" }).waitFor();
  await page.getByRole("heading", { name: "AI エージェント（MCP）" }).waitFor();
  const cmd = await page.getByLabel("Claude Code のコマンド").textContent();
  if (!cmd.startsWith("claude mcp add paperlens") || !cmd.includes("dist-server/mcp.js")) throw new Error(`コマンドが違う: ${cmd}`);
  await page.locator("section", { has: page.getByRole("heading", { name: "AI エージェント（MCP）" }) }).screenshot({ path: `${shotDir}/12-settings-mcp.png` });
  await page.getByLabel("読み取りだけを許可する").check();
  if (!(await page.getByLabel("Claude Code のコマンド").textContent()).includes("PAPERLENS_MCP_READONLY=1")) throw new Error("読み取り専用の設定にならない");
});

await step("読み直すと、前回の位置から表示する", async () => {
  // 設定のモーダルを閉じて論文に戻る
  await page.getByRole("dialog", { name: "設定" }).getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("dialog", { name: "設定" }).waitFor({ state: "detached" });
  const input = page.getByLabel("ページ番号");
  await input.fill("2");
  await input.press("Enter");
  await page.waitForTimeout(1500); // 位置の保存は 1 秒に 1 回
  await page.reload();
  await page.locator(".snackbar", { hasText: "前回の位置（p.2）から表示しています" }).waitFor();
  const visible = await page.evaluate(() => {
    const box = document.querySelector(".pdf-scroll").getBoundingClientRect();
    const r = document.querySelector('[data-page="2"]').getBoundingClientRect();
    return r.top < box.bottom && r.bottom > box.top + box.height / 3;
  });
  if (!visible) throw new Error("2 ページ目が表示されていない");
  await page.screenshot({ path: `${shotDir}/13-restore.png` });
  await page.getByRole("button", { name: "先頭に戻る" }).click();
  await page.waitForFunction(() => document.querySelector(".pdf-scroll").scrollTop <= 50);
});

await step("URL から取り込む（新しい論文は書誌情報の欄を開き、同じ URL は既存を開く）", async () => {
  const url = `http://127.0.0.1:5297/api/papers/${encodeURIComponent(id)}/pdf`;
  const count = () => readdirSync(path.join(data, "papers")).length;
  const before = count();
  const add = async () => {
    await openLeft();
    await page.getByRole("button", { name: "論文を追加", exact: true }).click();
    await page.getByRole("menuitem", { name: "URL から追加" }).click();
    await page.getByLabel("PDF の URL か arXiv の番号").fill(url);
  };
  await add();
  await page.screenshot({ path: `${shotDir}/14-url-dialog.png` });
  await page.getByRole("button", { name: "取り込む" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.locator(".biblio[open]").waitFor();
  if (count() !== before + 1) throw new Error(`論文が増えていない: ${count()}`);
  await add();
  await page.getByRole("button", { name: "取り込む" }).click();
  await page.locator(".snackbar", { hasText: "この論文は既に取り込んでいます。開きました。" }).waitFor();
  if (count() !== before + 1) throw new Error("同じ URL で論文が増えた");
});

const md = readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
for (const want of ["status: 精読", "画面から書いた要約。", "エージェントが書いた読む目的。", "> [!quote] p.1（水色）", "> 訳: Transformer は長い", "### [[疎な窓付き注意（sparse window attention）]]", "O(n \\cdot w)", "> 訳: 画面で付けた訳。"]) {
  if (!md.includes(want)) {
    console.error(md);
    throw new Error(`note.md に「${want}」が無い`);
  }
}
console.log("✓ note.md に画面とエージェントの両方の記録が入っている");
console.log("console errors:", errors.length ? errors : "なし");
await client.close();
await done(errors.length ? 1 : 0);

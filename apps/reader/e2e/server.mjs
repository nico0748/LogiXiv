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
const env = { ...process.env, PAPERLENS_DATA: data, PAPERLENS_PORT: "5297" };

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
const done = async (code) => { await browser.close(); server.kill(); process.exit(code); };
process.on("unhandledRejection", async (e) => { console.error(e); await done(1); });

await page.goto("http://127.0.0.1:5297/");

await step("サーバーの保存先で開く", async () => {
  await page.getByText("論文はまだありません").waitFor();
  const crumb = await page.locator(".crumb").textContent();
  if (!crumb.includes(path.basename(data))) throw new Error(`保存先の名前が出ていない: ${crumb}`);
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
  await page.getByRole("tab", { name: "記録" }).click();
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
  await page.locator(".paper-item .tag", { hasText: "精読" }).waitFor({ timeout: 5000 });
  if ((await page.locator("#f-summary").inputValue()) !== "画面から書いた要約。") throw new Error("画面で書いた記録が消えた");
  if ((await page.locator(".mk.green").count()) === 0) throw new Error("画面で引いたマーカーが消えた");
  await page.getByRole("tab", { name: /訳/ }).click();
  await page.getByText("Transformer は長い学術文書を読むのが苦手である。").waitFor();
  await page.screenshot({ path: `${shotDir}/11-mcp-live.png` });
  await page.getByRole("tab", { name: /用語/ }).click();
  await page.getByText("各トークンが近くの窓の中だけに").waitFor();
});

await step("画面の変更をエージェントが読める", async () => {
  await page.getByRole("tab", { name: /訳/ }).click();
  await page.locator(".card", { hasText: "We propose" }).locator("textarea.trans").fill("画面で付けた訳。");
  await page.waitForTimeout(1200);
  const p = JSON.parse(await call("get_paper", { paper: id }));
  if (!p.annotations.highlights.some((h) => h.translation === "画面で付けた訳。")) throw new Error("画面の訳がエージェントから見えない");
  if (p.annotations.highlights.length !== 2) throw new Error(`マーカーの数が違う: ${p.annotations.highlights.length}`);
});

await step("設定画面に MCP の登録方法が出る", async () => {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("heading", { name: "AI エージェント（MCP）" }).waitFor();
  const cmd = await page.getByLabel("Claude Code のコマンド").textContent();
  if (!cmd.startsWith("claude mcp add paperlens") || !cmd.includes("dist-server/mcp.js")) throw new Error(`コマンドが違う: ${cmd}`);
  await page.locator("section", { has: page.getByRole("heading", { name: "AI エージェント（MCP）" }) }).screenshot({ path: `${shotDir}/12-settings-mcp.png` });
  await page.getByLabel("読み取りだけを許可する").check();
  if (!(await page.getByLabel("Claude Code のコマンド").textContent()).includes("PAPERLENS_MCP_READONLY=1")) throw new Error("読み取り専用の設定にならない");
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

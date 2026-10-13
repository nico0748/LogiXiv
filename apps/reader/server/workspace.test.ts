// 画面の配置（.paperlens/workspace.json）の読み書き。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NodeVault } from "./nodeVault.ts";
import { DEFAULT_WORKSPACE, WORKSPACE_PATH, readWorkspace, writeWorkspace } from "./workspace.ts";
import { normalizeWorkspace } from "../src/components/shell/workspaceState.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-ws-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("ファイルが無いときは既定の配置を返す", async () => {
  const v = new NodeVault(path.join(dir, "empty"));
  assert.deepEqual(await readWorkspace(v), DEFAULT_WORKSPACE);
  assert.equal(DEFAULT_WORKSPACE.leftOpen, false);
});

test("渡した項目だけを書き換え、残りは前の値を保つ", async () => {
  const v = new NodeVault(path.join(dir, "a"));
  await writeWorkspace(v, { leftOpen: true, leftWidth: 320 });
  const r = await writeWorkspace(v, { openPaper: "p1", leftTab: "search" });
  assert.equal(r.leftOpen, true);
  assert.equal(r.leftWidth, 320);
  assert.equal(r.openPaper, "p1");
  assert.equal(r.leftTab, "search");
  assert.deepEqual(await readWorkspace(v), r);
  assert.ok(fs.existsSync(path.join(v.root, WORKSPACE_PATH)));
});

test("同時に書いても互いの変更を消さない（要求ごとに別の NodeVault でも）", async () => {
  const root = path.join(dir, "b");
  const v = () => new NodeVault(root);
  await Promise.all([writeWorkspace(v(), { leftOpen: true }), writeWorkspace(v(), { rightOpen: false }), writeWorkspace(v(), { rightWidth: 500 })]);
  const r = await readWorkspace(v());
  assert.equal(r.leftOpen, true);
  assert.equal(r.rightOpen, false);
  assert.equal(r.rightWidth, 500);
});

test("壊れたファイルや不正な値は既定値で置き換える", async () => {
  const v = new NodeVault(path.join(dir, "c"));
  await v.writeText(WORKSPACE_PATH, "{ not json");
  assert.deepEqual(await readWorkspace(v), DEFAULT_WORKSPACE);
  const n = normalizeWorkspace({ leftWidth: 5, rightWidth: 99999, leftTab: "x", openPaper: "../etc", leftOpen: "yes" });
  assert.equal(n.leftWidth, 200);
  assert.equal(n.rightWidth, 640);
  assert.equal(n.leftTab, "files");
  assert.equal(n.openPaper, null);
  assert.equal(n.leftOpen, false);
});

// 保存先フォルダと待ち受けポートの設定。
//
// 保存先は次の順で決める。
//   1. 環境変数 PAPERLENS_DATA
//   2. 設定ファイル（PAPERLENS_CONFIG、無ければ <アプリ>/paperlens.config.json）の dataRoot
//   3. 既定値（PAPERLENS_DEFAULT_DATA、無ければ <アプリ>/data）
// MCP サーバーも同じ設定を読むので、画面と AI エージェントは同じフォルダを見る。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/reader の場所。ソースから動かしても、ビルドしたものを動かしても同じになる。 */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const configPath = () => process.env.PAPERLENS_CONFIG || path.join(APP_ROOT, "paperlens.config.json");

export interface Config {
  dataRoot: string;
  dataRootSource: "env" | "config" | "default";
  port: number;
}

const expand = (p: string) => path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function readFile(): { dataRoot?: string; port?: number } {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as { dataRoot?: string; port?: number };
  } catch {
    return {};
  }
}

export function readConfig(): Config {
  const file = readFile();
  const port = Number(process.env.PAPERLENS_PORT || file.port || 5175);
  if (process.env.PAPERLENS_DATA) return { dataRoot: expand(process.env.PAPERLENS_DATA), dataRootSource: "env", port };
  if (file.dataRoot) return { dataRoot: expand(file.dataRoot), dataRootSource: "config", port };
  const def = process.env.PAPERLENS_DEFAULT_DATA || path.join(APP_ROOT, "data");
  return { dataRoot: expand(def), dataRootSource: "default", port };
}

export function writeConfig(patch: { dataRoot?: string; port?: number }) {
  const next = { ...readFile(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** 保存先フォルダ。無ければ作る。 */
export function dataRoot() {
  const root = readConfig().dataRoot;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

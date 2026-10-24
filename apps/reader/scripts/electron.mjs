// 開発時（npm run app）に Electron を起動する。
// mac では、node_modules の Electron.app をそのまま使うと、Dock やメニューバーに「Electron」と出る。
// そこで Electron.app を PaperLens.app という名前で写し（APFS では実体を複製しないので一瞬で済む）、
// Info.plist の名前とアイコンを PaperLens に替えてから、その写しで起動する。
// node_modules/electron の中身は書き換えない（書き換えると npm install が Electron を入れ直そうとするため）。
// Electron の版が変わったら写し直す。mac 以外はそのまま起動する。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "PaperLens";
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
/** node_modules/electron/dist/Electron.app/Contents/MacOS/Electron など */
const electronBin = require("electron");

function macBundle() {
  const src = path.resolve(electronBin, "../../..");
  if (!src.endsWith(".app")) return electronBin;
  const electronDir = path.dirname(require.resolve("electron/package.json"));
  const version = fs.readFileSync(path.join(electronDir, "dist", "version"), "utf8").trim();
  const cacheDir = path.join(electronDir, "..", ".cache", "paperlens-dev");
  const app = path.join(cacheDir, `${NAME}.app`);
  const stamp = path.join(cacheDir, "version");
  const bin = path.join(app, "Contents", "MacOS", path.basename(electronBin));
  const fresh = fs.existsSync(bin) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === version;
  if (fresh) return bin;

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  try {
    execFileSync("cp", ["-cR", src, app]); // APFS の複製（clonefile）
  } catch {
    fs.rmSync(app, { recursive: true, force: true });
    execFileSync("cp", ["-R", src, app]);
  }
  const plist = path.join(app, "Contents", "Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) execFileSync("plutil", ["-replace", key, "-string", NAME, plist]);
  // Dock に出るアイコン（起動した直後、main.js が差し替えるまでの間も PaperLens のものにする）
  const icns = path.join(appRoot, "build", "icon.icns");
  if (fs.existsSync(icns)) fs.copyFileSync(icns, path.join(app, "Contents", "Resources", "electron.icns"));
  // Info.plist を替えると元の署名と合わなくなるので、手元用の署名（ad-hoc）を付け直す
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  } catch {
    /* 付け直せなくても、多くの場合はそのまま起動できる */
  }
  // 名前とアイコンを変えたことを Finder と Dock に知らせる
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  try {
    execFileSync(lsregister, ["-f", app]);
  } catch {
    /* 知らせられなくても起動はできる */
  }
  fs.writeFileSync(stamp, version);
  return bin;
}

let bin = electronBin;
if (process.platform === "darwin") {
  try {
    bin = macBundle();
  } catch (e) {
    console.warn(`PaperLens.app を用意できなかったので、Electron.app のまま起動します: ${e instanceof Error ? e.message : e}`);
  }
}

const child = spawn(bin, [appRoot, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

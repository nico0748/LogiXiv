/**
 * PaperLens デスクトップ版のメインプロセス。
 * ローカルサーバー（dist-server/app.js）を同じプロセスで立ち上げ、その URL をウィンドウに読み込む。
 * 画面のコードはブラウザで動かすときと同じもの。
 */
import { app as electronApp, BrowserWindow, Menu, dialog, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PACKAGED = electronApp.isPackaged;

// サーバーを読み込む前に、書き込める場所を指すよう環境変数を決める。
// MCP サーバーの設定にもこの値が入るため、AI エージェントも同じ保存先を見る。
const userData = electronApp.getPath("userData");
// 開発時（npm run app）の userData はパッケージ名から決まるため、@logixiv/reader → @paperlens/app の
// 改名で置き場が変わった。新しい側に設定が無く古い側にあるなら、古い設定を読み続ける。
const legacyDevConfig = path.join(electronApp.getPath("appData"), "@logixiv", "reader", "paperlens.config.json");
const currentConfig = path.join(userData, "paperlens.config.json");
process.env.PAPERLENS_CONFIG ||=
  !PACKAGED && !fs.existsSync(currentConfig) && fs.existsSync(legacyDevConfig) ? legacyDevConfig : currentConfig;
process.env.PAPERLENS_DEFAULT_DATA ||= PACKAGED
  ? path.join(electronApp.getPath("documents"), "PaperLens")
  : path.join(APP_ROOT, "data");

if (!fs.existsSync(path.join(APP_ROOT, "dist-server", "app.js"))) {
  dialog.showErrorBox("起動できませんでした", "先に npm run build を実行してください（dist-server/ がありません）。");
  electronApp.exit(1);
}
const { startServer, setHostBridge } = await import("../dist-server/app.js");

// 開発時（npm run app）と Linux のウィンドウに使うアイコン。配布版の mac / Windows はアプリ本体のアイコン（build/icon.*）が使われる。
const WINDOW_ICON = path.join(__dirname, "icon.png");

const STATE_FILE = path.join(userData, "window-state.json");
let mainWindow = null;
let serverUrl = "";

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* 初回は既定値を使う */
  }
  return { width: 1440, height: 940 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }, null, 2), "utf8");
  } catch {
    /* 保存できなくても起動には影響しない */
  }
}

/** 発表の窓（画面の「発表」で開く、URL に ?present= を付けた窓）か */
const isPresenterUrl = (url) => !!serverUrl && url.startsWith(serverUrl) && new URL(url).searchParams.has("present");

/** 発表の窓を出す画面。外部ディスプレイ（プロジェクター）があればそちら、無ければ元の窓と同じ画面 */
function presenterDisplay(opener) {
  const here = screen.getDisplayMatching(opener.getBounds());
  return screen.getAllDisplays().find((d) => d.id !== here.id) ?? here;
}

/**
 * 同じサーバーの URL はアプリ内で、それ以外（obsidian:// や論文のリンク）は既定のアプリで開く。
 * 発表の窓だけは新しいウィンドウとして開き、外部ディスプレイがあればそちらで全画面にする。
 */
function attachWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPresenterUrl(url)) {
      const { x, y, width, height } = presenterDisplay(win).bounds;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          x,
          y,
          width,
          height,
          title: "PaperLens 発表",
          icon: WINDOW_ICON,
          backgroundColor: "#f2f2f2",
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
        },
      };
    }
    if (!serverUrl || !url.startsWith(serverUrl)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => {
    attachWindowOpenHandler(child);
    const fullScreen = () => child.setFullScreen(true);
    if (child.isVisible()) fullScreen();
    else child.once("show", fullScreen);
    // 元の窓へ戻る道を残す（全画面の発表の窓が前にあっても、台本の窓を前に出せるように）
    child.on("closed", () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
    });
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (serverUrl && url.startsWith(serverUrl)) return;
    e.preventDefault();
    shell.openExternal(url);
  });
}

function createWindow() {
  const state = readWindowState();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 640,
    title: "PaperLens",
    icon: WINDOW_ICON,
    backgroundColor: "#f2f2f2",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (state.maximized) mainWindow.maximize();
  mainWindow.loadURL(serverUrl);
  attachWindowOpenHandler(mainWindow);
  for (const ev of ["resize", "move", "close"]) mainWindow.on(ev, () => saveWindowState(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
    // 元の窓を閉じたら、発表の窓も閉じる（台本の無い発表の窓だけが残らないように）
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
}

async function currentDataRoot() {
  const res = await fetch(`${serverUrl}/api/meta`);
  return (await res.json()).dataRoot;
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: "PaperLens",
            submenu: [
              { role: "about", label: "PaperLens について" },
              { type: "separator" },
              { role: "hide", label: "PaperLens を隠す" },
              { role: "hideOthers", label: "ほかを隠す" },
              { role: "unhide", label: "すべてを表示" },
              { type: "separator" },
              { role: "quit", label: "PaperLens を終了" },
            ],
          },
        ]
      : []),
    {
      label: "ファイル",
      submenu: [
        {
          label: "保存先フォルダを開く",
          accelerator: "CmdOrCtrl+Shift+O",
          click: async () => {
            shell.openPath(await currentDataRoot());
          },
        },
        { type: "separator" },
        isMac ? { role: "close", label: "ウィンドウを閉じる" } : { role: "quit", label: "終了" },
      ],
    },
    {
      label: "編集",
      submenu: [
        { role: "undo", label: "取り消す" },
        { role: "redo", label: "やり直す" },
        { type: "separator" },
        { role: "cut", label: "切り取り" },
        { role: "copy", label: "コピー" },
        { role: "paste", label: "貼り付け" },
        { role: "selectAll", label: "すべてを選択" },
      ],
    },
    {
      label: "表示",
      submenu: [
        { role: "reload", label: "再読み込み" },
        { type: "separator" },
        { role: "resetZoom", label: "実際のサイズ" },
        { role: "zoomIn", label: "拡大" },
        { role: "zoomOut", label: "縮小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "フルスクリーン" },
        { role: "toggleDevTools", label: "開発者ツール" },
      ],
    },
    {
      label: "ウィンドウ",
      submenu: [
        { role: "minimize", label: "しまう" },
        { role: "zoom", label: "拡大/縮小" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!electronApp.requestSingleInstanceLock()) {
  electronApp.quit();
} else {
  electronApp.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  electronApp.whenReady().then(async () => {
    // 開発時は Electron の既定のアイコンが Dock に出るので差し替える
    if (!PACKAGED && process.platform === "darwin") electronApp.dock?.setIcon(WINDOW_ICON);
    setHostBridge({
      pickFolder: async (current) => {
        const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
          title: "論文と読解ノートの保存先を選ぶ",
          defaultPath: current || electronApp.getPath("documents"),
          properties: ["openDirectory", "createDirectory"],
          buttonLabel: "このフォルダを使う",
        });
        return res.canceled ? "" : res.filePaths[0];
      },
      reveal: async (target) => {
        await shell.openPath(target);
      },
    });

    try {
      // ポート 0 を渡すと、空いているポートを OS が選ぶ
      const started = await startServer({ port: 0 });
      serverUrl = started.url;
      console.log(`PaperLens: ${serverUrl}  保存先: ${started.dataRoot}`);
    } catch (err) {
      dialog.showErrorBox("起動できませんでした", String(err?.message || err));
      electronApp.quit();
      return;
    }

    buildMenu();
    createWindow();
    electronApp.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  electronApp.on("window-all-closed", () => {
    if (process.platform !== "darwin") electronApp.quit();
  });
}

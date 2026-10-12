// 開発用。ローカルサーバー（API）と Vite（画面）を一緒に起動する。
// 画面は http://localhost:5173 で開く。API は Vite が 127.0.0.1:5175 へ中継する。
import { spawn } from "node:child_process";

const procs = [
  spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--watch-path=server", "--watch-path=mcp", "--watch-path=src/lib", "server/main.ts"], {
    stdio: "inherit",
    env: { ...process.env, PAPERLENS_PORT: process.env.PAPERLENS_PORT || "5175" },
  }),
  spawn("npx", ["vite"], { stdio: "inherit", shell: process.platform === "win32" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGINT"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { stop(); process.exit(code ?? 0); }));

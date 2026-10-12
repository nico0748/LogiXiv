// npm start で動かす入口。ブラウザで表示された URL を開く。
import { startServer } from "./app.ts";

const s = await startServer();
console.log(`PaperLens を起動しました: ${s.url}`);
console.log(`保存先: ${s.dataRoot}`);
console.log("止めるときは Ctrl + C を押してください。");

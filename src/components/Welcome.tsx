import { useEffect, useState } from "react";
import sampleUrl from "../demo/sample.pdf?url";
import { importPaper, writeField, writeStatus } from "../lib/papers";
import { FsVault, MemoryVault, type Vault, canUseFolders, recallVault, rememberVault } from "../lib/vault";

export function Welcome({ onOpen }: { onOpen: (v: Vault) => void }) {
  const [last, setLast] = useState<FileSystemDirectoryHandle | null>(null);
  const [error, setError] = useState("");
  const folders = canUseFolders();

  useEffect(() => {
    if (folders) void recallVault().then(setLast);
  }, [folders]);

  const pick = async () => {
    setError("");
    try {
      const h = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ id: "paperlens", mode: "readwrite" });
      await rememberVault(h);
      onOpen(new FsVault(h));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(folders ? "フォルダを開けませんでした。別のフォルダを選んでください。" : "このブラウザではフォルダを開けません。");
    }
  };

  const reopen = async () => {
    if (!last) return;
    setError("");
    try {
      const h = last as FileSystemDirectoryHandle & { requestPermission: (o: object) => Promise<string> };
      if ((await h.requestPermission({ mode: "readwrite" })) !== "granted") {
        setError("フォルダへのアクセスが許可されませんでした。");
        return;
      }
      onOpen(new FsVault(last));
    } catch {
      setError("前回のフォルダを開けませんでした。フォルダを選び直してください。");
    }
  };

  const demo = async () => {
    const v = new MemoryVault();
    const data = await (await fetch(sampleUrl)).arrayBuffer();
    const id = await importPaper(v, "sparse-window-attention.pdf", data, "Sparse Window Attention for Reading Long Scientific Documents");
    await writeStatus(v, id, "概要把握");
    await writeField(v, id, "purpose", "長い論文を要約するモデルの設計に使えるかを確かめる。");
    onOpen(v);
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>PaperLens</h1>
        <p className="lead">論文を読みながら、訳・用語・数式・読解メモを Markdown のノートに残すアプリです。</p>
        <ul>
          <li>中央に論文の PDF、右側に選んだ文の訳、用語の説明、TeX 形式の数式を表示します。</li>
          <li>記録はテンプレートから作った読解ノート（note.md）に書き込みます。Obsidian でもそのまま開けます。</li>
          <li>データはすべて、選んだフォルダの中に普通のファイルとして保存します。</li>
        </ul>
        <div className="actions">
          {folders && <button className="btn primary" onClick={() => void pick()}>保管庫にするフォルダを選ぶ</button>}
          {folders && last && <button className="btn" onClick={() => void reopen()}>前回のフォルダを開く（{last.name}）</button>}
          <button className="btn" onClick={() => void demo()}>サンプルの論文で試す</button>
        </div>
        {error && <p className="err-msg" role="alert">{error}</p>}
        {!folders && (
          <p className="notice warn">
            このブラウザはフォルダの読み書きに対応していません。サンプルで試す場合、内容はページを閉じると消えます。フォルダに保存するには Chrome か Edge で開いてください。
          </p>
        )}
        <p className="notice">
          Obsidian の保管庫にしているフォルダを選ぶと、読解ノートを Obsidian からも編集できます。アプリは入力欄と一覧の範囲だけを書き換え、それ以外の部分は変更しません。
        </p>
      </div>
    </div>
  );
}

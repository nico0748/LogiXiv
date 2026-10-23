// ? キーで開くキーボード操作の早見表。Esc か ? でもう一度押すと閉じる（Esc は App がまとめて扱う）。
import { useState } from "react";
import { SHORTCUTS, filterShortcuts } from "../../lib/shortcuts.ts";
import { Modal } from "../shell/Modal.tsx";
import { ShortcutTable } from "../shell/HelpModal.tsx";
import "./help.css";

export function ShortcutSheet({ onClose, onOpenHelp }: { onClose: () => void; onOpenHelp: () => void }) {
  const [q, setQ] = useState("");
  const list = filterShortcuts(SHORTCUTS, q);
  return (
    <Modal title="キーボード操作の早見表" onClose={onClose} className="help-sheet">
      <div className="help-sheet-inner">
        <div className="help-sheet-head">
          <h1 className="help-title">キーボード操作</h1>
          <input
            type="search"
            className="input help-sheet-filter"
            placeholder="操作を探す"
            aria-label="キーボード操作を探す"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {list.length ? <ShortcutTable list={list} /> : <p className="help-lead">当てはまる操作はありません。</p>}
        <p className="help-sheet-foot">
          文字の入力中は <kbd>?</kbd> で開きません。
          <button type="button" className="help-link" onClick={onOpenHelp}>ヘルプで詳しく見る</button>
        </p>
      </div>
    </Modal>
  );
}

// 設定ページを Obsidian の設定画面の形（モーダル＋左の項目一覧）で見せる。中身は SettingsPage のまま。
import { useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import { SettingsPage } from "../SettingsPage.tsx";
import { Modal, type ModalNavItem } from "./Modal.tsx";

interface Props {
  backend: Backend;
  aiReady: boolean;
  onOpenClaude: () => void;
  onOpenTemplate: () => void;
  onClose: () => void;
  onSwitchVault?: () => void;
}

export function SettingsModal({ backend, aiReady, onOpenClaude, onOpenTemplate, onClose, onSwitchVault }: Props) {
  const nav: ModalNavItem[] = [
    { id: "sec-data", label: backend.kind === "server" ? "保存先フォルダ" : "保管庫", group: "全般" },
    { id: "sec-claude", label: "Claude", group: "全般" },
    { id: "sec-template", label: "テンプレート", group: "全般" },
    { id: "sec-mcp", label: "AI エージェント（MCP）", group: "連携" },
  ];
  const [active, setActive] = useState(nav[0].id);
  return (
    <Modal
      title="設定"
      onClose={onClose}
      className="mod-settings"
      nav={nav}
      activeNav={active}
      onNav={(id) => {
        setActive(id);
        document.getElementById(id)?.closest("section")?.scrollIntoView({ block: "start", behavior: "smooth" });
      }}
    >
      <SettingsPage backend={backend} aiReady={aiReady} onOpenClaude={onOpenClaude} onOpenTemplate={onOpenTemplate} onClose={onSwitchVault} />
    </Modal>
  );
}

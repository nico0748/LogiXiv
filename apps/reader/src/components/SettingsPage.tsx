// 設定の 1 ページ分。左のナビで選んだページだけを出す（中身は components/settings/ の各ページ）。
import type { Backend } from "../lib/backend.ts";
import { SETTINGS_PAGES, type SettingsPageId } from "../lib/settingsIndex.ts";
import { AiPage } from "./settings/AiPage.tsx";
import { DataPage } from "./settings/DataPage.tsx";
import { DisplayPage } from "./settings/DisplayPage.tsx";
import { GeneralPage } from "./settings/GeneralPage.tsx";
import { AboutPage, ShortcutsPage } from "./settings/InfoPages.tsx";
import { McpPage, ObsidianPage } from "./settings/IntegrationPages.tsx";
import { PageHeader } from "./settings/Setting.tsx";
import { TemplatePage } from "./settings/TemplatePage.tsx";

const LEAD: Partial<Record<SettingsPageId, string>> = {
  display: "この端末のブラウザにだけ保存します。保管庫には書き込みません。",
  ai: "PDF の文を選んで「訳す」「用語を調べる」「数式にする」を押したときに使います。この端末のブラウザにだけ保存します。",
  template: "保管庫に保存します。同じ保管庫を開くほかの端末でも同じテンプレートになります。",
  mcp: "Claude Desktop や Claude Code から、PaperLens の論文とノートを読み書きできるようにします。",
  obsidian: "保存先のフォルダを Obsidian の保管庫として開くと、同じノートを両方で使えます。",
};

interface Props {
  page: SettingsPageId;
  backend: Backend;
  /** 1 ファイル版で「別の保管庫を開く」 */
  onSwitchVault?: () => void;
}

export function SettingsPage({ page, backend, onSwitchVault }: Props) {
  const info = SETTINGS_PAGES.find((p) => p.id === page) ?? SETTINGS_PAGES[0];
  return (
    <section className="settings-page" aria-labelledby={`settings-title-${info.id}`} data-page={info.id}>
      <PageHeader page={info}>{LEAD[info.id]}</PageHeader>
      {info.id === "general" && <GeneralPage backend={backend} onSwitchVault={onSwitchVault} />}
      {info.id === "display" && <DisplayPage sentences={backend.kind === "server"} />}
      {info.id === "ai" && <AiPage backend={backend} />}
      {info.id === "template" && <TemplatePage backend={backend} />}
      {info.id === "data" && <DataPage backend={backend} />}
      {info.id === "mcp" && <McpPage backend={backend} />}
      {info.id === "obsidian" && <ObsidianPage backend={backend} />}
      {info.id === "shortcuts" && <ShortcutsPage />}
      {info.id === "about" && <AboutPage backend={backend} />}
    </section>
  );
}

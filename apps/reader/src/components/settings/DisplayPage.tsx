// 表示: テーマ・アクセント色・文字の大きさと行間・PDF の倍率・対訳の文の枠・論文一覧の並び順。
import { SORT_KEYS, SORT_LABEL, isSortKey } from "../../lib/paperSort.ts";
import { ACCENTS, type DisplayPrefs, FONT_DEFAULT, FONT_MAX, FONT_MIN, PDF_ZOOMS, patchPref, setPref, usePref } from "../../lib/prefs.ts";
import { ACCENT_LABEL, ACCENT_SWATCH } from "./display.ts";
import { Select, SettingHeading, SettingItem, Segmented, Toggle, useSettingDesc } from "./Setting.tsx";

export function DisplayPage({ sentences }: { sentences: boolean }) {
  const theme = usePref("theme");
  const accent = usePref("accent");
  const display = usePref("display");
  const zoom = usePref("pdfZoom");
  const marks = usePref("sentenceMarks");
  const sort = usePref("paperSort");

  return (
    <>
      <SettingHeading>見た目</SettingHeading>
      <SettingItem id="theme" name="テーマ" desc="「システム」は端末の明暗の設定に合わせます。右上の月と太陽のボタンでも切り替えられます。">
        <Segmented
          label="テーマ"
          value={theme}
          options={[
            { value: "light", label: "ライト" },
            { value: "dark", label: "ダーク" },
            { value: "system", label: "システム" },
          ]}
          onChange={(v) => setPref("theme", v)}
        />
      </SettingItem>
      <SettingItem id="accent" name="アクセント色" desc="ボタン、選んだ項目、リンクの色です。">
        <div className="swatches" role="radiogroup" aria-label="アクセント色">
          {ACCENTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={accent === a}
              aria-label={ACCENT_LABEL[a]}
              title={ACCENT_LABEL[a]}
              className={`swatch${accent === a ? " is-active" : ""}`}
              style={{ background: ACCENT_SWATCH[a] }}
              onClick={() => setPref("accent", a)}
            />
          ))}
        </div>
      </SettingItem>

      <SettingHeading>文字</SettingHeading>
      <FontSize id="font-body" field="fontBody" name="補足情報の文字サイズ" desc="右サイドバーの訳・用語・数式・対訳のカードです。PDF の文字の大きさは、PDF の倍率で変えます。" value={display.fontBody} />
      <FontSize id="font-note" field="fontNote" name="記録欄の文字サイズ" desc="右サイドバーの「記録」タブの入力欄です。" value={display.fontNote} />
      <FontSize id="font-sidebar" field="fontSidebar" name="論文一覧の文字サイズ" desc="左サイドバーの論文一覧と検索です。" value={display.fontSidebar} />
      <SettingItem id="leading" name="行間" desc="訳・対訳・記録の行の間隔です。">
        <Segmented
          label="行間"
          value={display.leading}
          options={[
            { value: "compact", label: "狭い" },
            { value: "normal", label: "標準" },
            { value: "relaxed", label: "広い" },
          ]}
          onChange={(v) => patchPref("display", { leading: v })}
        />
      </SettingItem>

      <SettingHeading>PDF と一覧</SettingHeading>
      <SettingItem id="pdf-zoom" name="PDF の既定の倍率" desc="論文を開いたときの大きさです。倍率は画面の幅を基準にします。開いたあとは PDF の上の − ＋ で変えられます。" htmlFor="pdf-zoom">
        <Select id="pdf-zoom" value={zoom} onChange={(e) => setPref("pdfZoom", Number(e.target.value))}>
          {PDF_ZOOMS.map((z) => (
            <option key={z} value={z}>{z === 1 ? "幅に合わせる" : `幅の ${Math.round(z * 100)}%`}</option>
          ))}
        </Select>
      </SettingItem>
      <SettingItem
        id="sentence-marks"
        name="対訳の文の枠"
        desc={sentences ? "PDF の上に、対訳の文ごとの枠を出します。枠を押すと対訳のカードへ移ります。" : "対訳はローカルサーバー版とデスクトップ版で使えます。いま開いているブラウザだけの版では使えません。"}
      >
        <Toggle label="対訳の文の枠を出す" checked={sentences && marks} disabled={!sentences} onChange={(v) => setPref("sentenceMarks", v)} />
      </SettingItem>
      <SettingItem id="paper-sort" name="論文一覧の並び順" desc="左サイドバーの論文一覧の並び順です。一覧の「並び順」で変えた場合もここに残ります。" htmlFor="pref-paper-sort">
        <Select id="pref-paper-sort" value={sort} onChange={(e) => isSortKey(e.target.value) && setPref("paperSort", e.target.value)}>
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>{SORT_LABEL[k]}</option>
          ))}
        </Select>
      </SettingItem>
    </>
  );
}

function FontSize({ id, field, name, desc, value }: { id: string; field: keyof Omit<DisplayPrefs, "leading">; name: string; desc: string; value: number }) {
  const inputId = `pref-${id}`;
  return (
    <SettingItem id={id} name={name} desc={desc} htmlFor={inputId}>
      <Slider inputId={inputId} field={field} value={value} />
    </SettingItem>
  );
}

function Slider({ inputId, field, value }: { inputId: string; field: keyof Omit<DisplayPrefs, "leading">; value: number }) {
  const desc = useSettingDesc();
  return (
      <div className="slider-row">
        <input
          id={inputId}
          type="range"
          className="slider"
          min={FONT_MIN}
          max={FONT_MAX}
          step={1}
          value={value}
          aria-valuetext={`${value} ピクセル`}
          aria-describedby={desc}
          onChange={(e) => patchPref("display", { [field]: Number(e.target.value) })}
        />
        <output className="slider-value" htmlFor={inputId}>{value}px</output>
        <button type="button" className="btn text sm" disabled={value === FONT_DEFAULT} onClick={() => patchPref("display", { [field]: FONT_DEFAULT })}>
          戻す
        </button>
      </div>
  );
}

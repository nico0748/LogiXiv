// 読解ノート（Markdown）のテンプレート処理。
//
// テンプレートは普通の Markdown で、アプリが読み書きする範囲だけを HTML コメントで囲む。
// Obsidian などの閲覧画面ではコメントが表示されないため、ノートはそのまま読める。
//
//   <!-- field: summary | 一言でいうと | 1〜2文で書く -->
//   ここに入力内容が入る
//   <!-- /field -->
//
//   <!-- list: highlights -->
//   （アプリがマーカー一覧を書き出す）
//   <!-- /list -->
//
// 範囲の外側はアプリから変更しない。利用者が自由に書き足せる。

export interface FieldDef {
  id: string;
  label: string;
  hint: string;
  /** 直前の見出し（## レベル）。記録タブでフェーズとしてまとめる。 */
  section: string;
  value: string;
}

const FIELD_RE =
  /<!--\s*field:\s*([\w-]+)\s*(?:\|\s*([^|>]*?)\s*)?(?:\|\s*([^>]*?)\s*)?-->([\s\S]*?)<!--\s*\/field\s*-->/g;

const LIST_RE = (id: string) =>
  new RegExp(
    `(<!--\\s*list:\\s*${escapeRe(id)}\\s*-->)([\\s\\S]*?)(<!--\\s*\\/list\\s*-->)`,
  );

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** {{title}} などの差し込み項目を置き換えて、新しいノートの本文を作る。 */
export function fillPlaceholders(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, key: string) =>
    key in values ? values[key] : m,
  );
}

/** ノート本文から入力欄の定義と現在値を取り出す。 */
export function parseFields(md: string): FieldDef[] {
  const fields: FieldDef[] = [];
  FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_RE.exec(md))) {
    const before = md.slice(0, m.index);
    const headings = [...before.matchAll(/^##\s+(.+)$/gm)];
    const section = headings.length
      ? headings[headings.length - 1][1].trim()
      : "";
    fields.push({
      id: m[1],
      label: (m[2] ?? "").trim() || m[1],
      hint: (m[3] ?? "").trim(),
      section,
      value: trimBlock(m[4]),
    });
  }
  return fields;
}

/** 入力欄の値だけを書き換える。他の部分は1文字も変えない。 */
export function setField(md: string, id: string, value: string): string {
  FIELD_RE.lastIndex = 0;
  return md.replace(FIELD_RE, (whole, fid: string, label, hint, _body) => {
    if (fid !== id) return whole;
    const open = whole.slice(0, whole.indexOf("-->") + 3);
    const body = value.trim() ? `\n${value.trim()}\n` : "\n\n";
    void label;
    void hint;
    return `${open}${body}<!-- /field -->`;
  });
}

/** アプリが管理する一覧の範囲を書き換える。範囲が無いノートは末尾に節を足す。 */
export function setList(
  md: string,
  id: string,
  body: string,
  fallbackHeading: string,
): string {
  const re = LIST_RE(id);
  const content = body.trim() ? `\n${body.trim()}\n` : "\n";
  if (re.test(md)) {
    return md.replace(re, (_w, open: string, _old, close: string) => {
      return `${open}${content}${close}`;
    });
  }
  const sep = md.endsWith("\n") ? "\n" : "\n\n";
  return `${md}${sep}## ${fallbackHeading}\n\n<!-- list: ${id} -->${content}<!-- /list -->\n`;
}

// --- frontmatter -----------------------------------------------------------

export function getFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = unquote(kv[2].trim());
  }
  return out;
}

/** frontmatter の1項目だけを書き換える。項目が無ければ追加する。 */
export function setFrontmatter(md: string, key: string, value: string): string {
  const line = `${key}: ${yamlScalar(value)}`;
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return `---\n${line}\n---\n\n${md}`;
  const lines = m[1].split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return `---\n${lines.join("\n")}\n---${md.slice(m[0].length)}`;
}

function unquote(s: string) {
  if (/^".*"$/.test(s)) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function yamlScalar(v: string) {
  if (v === "") return '""';
  if (/^[\w　-鿿＀-￯-]+$/.test(v)) return v;
  return JSON.stringify(v);
}

function trimBlock(s: string) {
  return s.replace(/^\s*\n/, "").replace(/\n\s*$/, "").trim();
}

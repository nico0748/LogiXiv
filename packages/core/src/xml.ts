/**
 * TEI を読むためだけの最小 XML パーサ。
 *
 * 外部依存を足さないのは意地ではなく、GROBID の出力が名前空間付き・巨大・
 * 属性が多いという偏った形をしていて、汎用パーサの半分の機能しか使わないから。
 * 対応するのは要素・属性・テキスト・コメント・CDATA・PI・DOCTYPE と基本実体参照だけ。
 */

export interface XmlElement {
  type: 'element';
  /** 名前空間接頭辞を落とした後のローカル名。 */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function localName(qname: string): string {
  const colon = qname.indexOf(':');
  return colon === -1 ? qname : qname.slice(colon + 1);
}

export function parseXml(source: string): XmlElement {
  let i = 0;
  const root: XmlElement = { type: 'element', name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];

  const top = (): XmlElement => stack[stack.length - 1]!;

  const pushText = (raw: string): void => {
    if (raw.length === 0) return;
    top().children.push({ type: 'text', value: decodeEntities(raw) });
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      pushText(source.slice(i));
      break;
    }
    pushText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const value = source.slice(lt + 9, end === -1 ? source.length : end);
      if (value.length > 0) top().children.push({ type: 'text', value });
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) {
      pushText(source.slice(lt));
      break;
    }
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith('/')) {
      const name = localName(inner.slice(1).trim());
      // 閉じタグは、対応する開始タグが見つかる範囲でだけ巻き戻す（壊れた入力で全体を捨てない）。
      for (let depth = stack.length - 1; depth >= 1; depth--) {
        if (stack[depth]!.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const element: XmlElement = {
      type: 'element',
      name: localName(nameMatch[1]!),
      attrs: parseAttrs(body.slice(nameMatch[1]!.length)),
      children: [],
    };
    top().children.push(element);
    if (!selfClosing) stack.push(element);
  }

  return root;
}

/** 属性値の中に現れる '>' でタグを切らないための走査。 */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const value = m[3] ?? m[4] ?? '';
    attrs[localName(m[1]!)] = decodeEntities(value);
  }
  return attrs;
}

export function children(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => c.type === 'element' && c.name === name);
}

export function firstChild(node: XmlElement, name: string): XmlElement | null {
  for (const c of node.children) {
    if (c.type === 'element' && c.name === name) return c;
  }
  return null;
}

/** name を / でつないだ相対パスで最初の 1 件を取る。 */
export function findPath(node: XmlElement, path: string): XmlElement | null {
  let current: XmlElement | null = node;
  for (const step of path.split('/')) {
    if (!current) return null;
    current = firstChild(current, step);
  }
  return current;
}

export function* descendants(node: XmlElement, name: string): Generator<XmlElement> {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.name === name) yield child;
    yield* descendants(child, name);
  }
}

/** 子孫のテキストを連結する。数式・参照番号のためにタグ境界へ空白は入れない。 */
export function textContent(node: XmlNode): string {
  if (node.type === 'text') return node.value;
  let out = '';
  for (const child of node.children) out += textContent(child);
  return out;
}

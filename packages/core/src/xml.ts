/**
 * TEI を読むためだけの最小 XML パーサ。
 *
 * 外部依存を足さないのは意地ではなく、GROBID の出力が名前空間付き・巨大・
 * 属性が多いという偏った形をしていて、汎用パーサの半分の機能しか使わないから。
 * 対応するのは要素・属性・テキスト・コメント・CDATA・PI・DOCTYPE と基本実体参照だけ。
 *
 * 入力は「他人が作った壊れた XML」でありうるので、次を守る:
 *  - 実体参照が不正なコードポイントでも例外を投げない
 *  - 閉じタグが欠けていても木が無限に深くならない（MAX_DEPTH）
 *  - 木を歩く関数は再帰せず明示スタックで回す（深い木でスタックを溢れさせない）
 */

export interface XmlElement {
  type: 'element';
  /** 名前空間接頭辞を落とした後のローカル名。 */
  name: string;
  /** ローカル名のキー。接頭辞付きの綴り（xml:id など）も同時に入る。 */
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

/** 閉じタグが欠けた入力で木が深くなりすぎるのを防ぐ。TEI の実用上の深さは 20 程度。 */
const MAX_DEPTH = 256;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const MAX_CODE_POINT = 0x10ffff;

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // 範囲外・サロゲート単独は String.fromCodePoint が投げるので、元の文字列のまま返す。
      if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
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
    if (!selfClosing && stack.length < MAX_DEPTH) stack.push(element);
  }

  return root;
}

/** 属性値の中に現れる '>' でタグを切らないための走査。 */
export function findTagEnd(source: string, from: number): number {
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

export function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const raw = m[1]!;
    const value = decodeEntities(m[3] ?? m[4] ?? '');
    // 接頭辞付きの綴りも残す。xml:id と id が両方あるとき、どちらかが消えないように。
    if (!(raw in attrs)) attrs[raw] = value;
    const local = localName(raw);
    if (!(local in attrs)) attrs[local] = value;
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

/** 子孫を文書順に返す。深い木でも落ちないよう明示スタックで回す。 */
export function* descendants(node: XmlElement, name: string): Generator<XmlElement> {
  const stack: XmlNode[] = [...node.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type !== 'element') continue;
    if (current.name === name) yield current;
    for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]!);
  }
}

/** 子孫のテキストを連結する。数式・参照番号のためにタグ境界へ空白は入れない。 */
export function textContent(node: XmlNode): string {
  if (node.type === 'text') return node.value;
  let out = '';
  const stack: XmlNode[] = [...node.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'text') {
      out += current.value;
      continue;
    }
    for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]!);
  }
  return out;
}

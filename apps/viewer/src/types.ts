/**
 * 書き出し HTML に埋まっている JSON の形。
 *
 * core の型をそのまま import せず最小限だけ写しているのは、ビューアが
 * 「10 年後にその HTML 単体で開ける」ことを目標にしているから。
 * 本体側の型が育っても、ビューアは自分が読む分だけ知っていればよい。
 */

export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sentence {
  id: string;
  hash: string;
  order: number;
  page: number;
  text: string;
  rects: Rect[];
  sectionId: string | null;
}

export interface Section {
  id: string;
  title: string;
  level: number;
  order: number;
}

export interface Translation {
  text: string;
  revisedByHuman: boolean;
  source: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  sentenceHash: string;
  body: string;
  author: string | null;
  createdAt: string;
}

export interface ExportPayload {
  format: 'logixiv-export';
  formatVersion: 1;
  exportedAt: string;
  pdfBase64: string;
  document: {
    id: string;
    title: string;
    structure: {
      parser: string;
      parserNote: string;
      sections: Section[];
      sentences: Sentence[];
    };
    annotations: {
      translations: Record<string, Translation>;
      notes: Note[];
      glossary: { term: string; translation: string; note: string | null }[];
      /**
       * 「訳す対象ではない」と判断した文（参考文献・数式など）。
       *
       * 埋め込む JSON には最初から入っていたのに、この型が持っていなかったので
       * ビューアは読まず、（訳さない）の文を（未訳）として描いていた。
       * 受け取った側には「訳し忘れが残っている」としか見えない。
       */
      skipped?: Record<string, { sentenceHash: string; reason: string; at: string }>;
    };
  };
}

// 訳・用語の説明・数式の書き起こしを Claude に頼む。
//
// API キーは利用者のブラウザ（localStorage）にだけ保存し、保管庫には書かない。
// 保管庫を Git や同期サービスで共有してもキーが漏れないようにするため。
// 送信するのは選択した範囲の文と、その前後の数文、論文の題名だけ。PDF 全体は送らない。

import Anthropic from "@anthropic-ai/sdk";

export interface AiSettings {
  apiKey: string;
  model: string;
}

const KEY = "paperlens.ai";
export const DEFAULT_MODEL = "claude-opus-5-5";

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { apiKey: "", model: DEFAULT_MODEL, ...JSON.parse(raw) };
  } catch {
    // localStorage が使えない環境では毎回入力してもらう
  }
  return { apiKey: "", model: DEFAULT_MODEL };
}

export function saveAiSettings(s: AiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても、この画面を開いている間は使える
  }
}

export class AiUnavailable extends Error {}

const STYLE = `日本語は次の方針で書く。
- 学術的な平叙文（である調）。1文は40字前後を目安にし、読点は1文に2つまで。
- 比喩や誇張を使わない。「〜と言えるでしょう」のような締めの言葉を付けない。
- 原文にない主張や数値を足さない。原文の条件や数値はそのまま残す。
- 専門用語は日本語の定訳を使い、初出で英語を括弧で添える。例: 自己注意（self-attention）。定訳が無い語は英語のまま書く。
- 指示語（これ、それ）より具体的な名詞を使う。`;

async function askJson<T>(
  s: AiSettings,
  system: string,
  content: Anthropic.Beta.Messages.BetaContentBlockParam[],
  schema: Record<string, unknown>,
  effort: "low" | "medium",
): Promise<T> {
  if (!s.apiKey) throw new AiUnavailable("API キーが設定されていません");
  const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: s.model || DEFAULT_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema } },
    // 安全上の理由で断られたときは、別のモデルで自動的にやり直す
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal") {
    throw new Error("この内容は処理できませんでした。範囲を変えてもう一度試してください。");
  }
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(text) as T;
}

export interface PaperContext {
  title: string;
  /** 選択範囲の前後の本文。訳語や用語の意味を文脈に合わせるために使う。 */
  around: string;
}

export async function translate(s: AiSettings, text: string, ctx: PaperContext) {
  const r = await askJson<{ translation: string }>(
    s,
    `あなたは英語の学術論文を日本語に訳す翻訳者である。\n${STYLE}`,
    [
      {
        type: "text",
        text: `論文: ${ctx.title}\n\n前後の本文（参考）:\n${ctx.around}\n\n次の箇所を日本語に訳す。PDF から抽出したため、改行やハイフンで単語が切れている場合は直してから訳す。\n\n${text}`,
      },
    ],
    {
      type: "object",
      properties: { translation: { type: "string" } },
      required: ["translation"],
      additionalProperties: false,
    },
    "low",
  );
  return r.translation;
}

export interface TermExplanation {
  term: string;
  reading: string;
  short: string;
  detail: string;
  inPaper: string;
  related: string[];
}

export async function explainTerm(s: AiSettings, term: string, ctx: PaperContext) {
  return askJson<TermExplanation>(
    s,
    `あなたは研究者向けに専門用語を説明する。\n${STYLE}\n確かでない内容は「〜とされる」ではなく「論文中では定義されていない」のように事実として書く。`,
    [
      {
        type: "text",
        text: `論文: ${ctx.title}\n\n用語が出てくる箇所:\n${ctx.around}\n\n用語: ${term}\n\n次の項目を書く。\n- term: 見出し語。英語の用語は英語のまま、日本語の定訳があれば「日本語（English）」の形\n- reading: 日本語の見出し語の読み。不要なら空文字\n- short: 1文の定義\n- detail: 2〜4文の説明。仕組みや前提を含める\n- inPaper: この論文での使われ方。前後の本文から分かる範囲で1〜2文\n- related: 関連する用語を3つまで`,
      },
    ],
    {
      type: "object",
      properties: {
        term: { type: "string" },
        reading: { type: "string" },
        short: { type: "string" },
        detail: { type: "string" },
        inPaper: { type: "string" },
        related: { type: "array", items: { type: "string" } },
      },
      required: ["term", "reading", "short", "detail", "inPaper", "related"],
      additionalProperties: false,
    },
    "medium",
  );
}

export interface TexResult {
  tex: string;
  explanation: string;
}

/**
 * 数式を TeX に書き起こす。PDF から抽出した文字列は記号が崩れやすいため、
 * 選択範囲を切り出した画像も一緒に送る。
 */
export async function toTex(
  s: AiSettings,
  extracted: string,
  imagePng: string | null,
  ctx: PaperContext,
) {
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  if (imagePng) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: imagePng },
    });
  }
  content.push({
    type: "text",
    text: `論文: ${ctx.title}\n\nPDF から抽出した文字列（崩れている場合がある）:\n${extracted}\n\n${imagePng ? "画像の数式を" : "この数式を"} KaTeX で表示できる TeX に書き起こす。$ や $$ で囲まない。式番号は含めない。explanation には各記号の意味を前後の本文から分かる範囲で1〜3文で書く。\n\n前後の本文:\n${ctx.around}`,
  });
  return askJson<TexResult>(
    s,
    `あなたは論文の数式を TeX に書き起こす。\n${STYLE}`,
    content,
    {
      type: "object",
      properties: { tex: { type: "string" }, explanation: { type: "string" } },
      required: ["tex", "explanation"],
      additionalProperties: false,
    },
    "medium",
  );
}

export function describeError(e: unknown): string {
  if (e instanceof AiUnavailable) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "API キーが正しくありません。設定を確認してください。";
  if (e instanceof Anthropic.RateLimitError) return "利用上限に達しました。少し待ってからもう一度試してください。";
  if (e instanceof Anthropic.APIConnectionError) return "Claude に接続できませんでした。ネットワークを確認してください。";
  if (e instanceof Anthropic.APIError) return `Claude からエラーが返りました（${e.status ?? "不明"}）。`;
  if (e instanceof Error) return e.message;
  return "不明なエラーが発生しました。";
}

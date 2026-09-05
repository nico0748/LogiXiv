/** HTML テキストノード用のエスケープ。属性値にも使えるよう引用符も潰す。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * script 要素の中に JSON を置くためのエスケープ。
 * 本文に script の閉じタグが含まれていても要素が閉じないよう < と > を潰す。
 * U+2028 / U+2029 は古い JS パーサで行終端として扱われるので併せてエスケープする。
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

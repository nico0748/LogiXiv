import assert from "node:assert/strict";
import { test } from "node:test";
import { presenterUrl, presentingPaper } from "./presenter.ts";

test("発表の窓の URL は論文の ID だけを持ち、元の URL の検索語とハッシュを落とす", () => {
  const url = presenterUrl("http://127.0.0.1:5175/?x=1#debug", "2024 tokuda/katori");
  assert.equal(url, "http://127.0.0.1:5175/?present=2024%20tokuda%2Fkatori");
  assert.equal(presentingPaper(new URL(url).search), "2024 tokuda/katori");
});

test("present が無いか空なら、発表の窓ではない", () => {
  assert.equal(presentingPaper(""), null);
  assert.equal(presentingPaper("?present="), null);
});

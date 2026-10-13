import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { loadPos, posKey, savePos, throttleTrailing } from "./position.ts";

test("localStorage が無い環境でも例外にならない", () => {
  assert.equal(typeof (globalThis as { localStorage?: unknown }).localStorage, "undefined");
  assert.doesNotThrow(() => savePos(posKey("/data", "p1"), { page: 3, y: 0.2 }));
  assert.equal(loadPos(posKey("/data", "p1")), null);
});

test("localStorage が例外を投げても止まらず、読めた値は検査する", () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  try {
    savePos("k", { page: 2, y: 0.123456 });
    assert.deepEqual(loadPos("k"), { page: 2, y: 0.1235 });
    store.set("k", "{broken");
    assert.equal(loadPos("k"), null);
    store.set("k", JSON.stringify({ page: 0, y: 0 }));
    assert.equal(loadPos("k"), null);
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.doesNotThrow(() => savePos("k", { page: 1, y: 0 }));
    assert.equal(loadPos("k"), null);
  } finally {
    delete g.localStorage;
  }
});

test("間引いても、最後の値は必ず保存する", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const saved: number[] = [];
    const t = throttleTrailing((n: number) => saved.push(n), 1000);
    t.call(1); // すぐに保存する
    t.call(2);
    t.call(3);
    assert.deepEqual(saved, [1]);
    mock.timers.tick(999);
    assert.deepEqual(saved, [1]);
    mock.timers.tick(1);
    assert.deepEqual(saved, [1, 3]); // 間の 2 は捨て、最後の 3 を保存する
    t.call(4);
    t.flush();
    assert.deepEqual(saved, [1, 3, 4]);
    mock.timers.tick(5000);
    assert.deepEqual(saved, [1, 3, 4]);
  } finally {
    mock.timers.reset();
  }
});

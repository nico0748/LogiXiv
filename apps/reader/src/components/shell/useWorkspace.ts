// 画面の配置を読み込み、変わったら少し待ってから保存する。
// サーバーで動いているときは保管庫の .paperlens/workspace.json（GET/PUT /api/workspace）に、
// そうでないとき（またはその API が無いとき）はブラウザの localStorage に保存する。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import { DEFAULT_WORKSPACE, type WorkspaceState, normalizeWorkspace } from "./workspaceState.ts";

const storageKey = (name: string) => `paperlens.workspace.${name}`;

function readLocal(name: string): WorkspaceState | null {
  try {
    const s = localStorage.getItem(storageKey(name));
    return s ? normalizeWorkspace(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

function writeLocal(name: string, ws: WorkspaceState) {
  try {
    localStorage.setItem(storageKey(name), JSON.stringify(ws));
  } catch {
    // 保存できなくても画面はそのまま使える
  }
}

/** 初めて開いたときの配置。狭い画面では右も閉じておく */
function initial(): WorkspaceState {
  const narrow = typeof window !== "undefined" && window.innerWidth <= 900;
  return { ...DEFAULT_WORKSPACE, rightOpen: !narrow };
}

export function useWorkspace(backend: Backend) {
  const [ws, setWs] = useState<WorkspaceState>(() => readLocal(backend.name) ?? initial());
  const [ready, setReady] = useState(false);
  /** サーバーに /api/workspace があるか。無ければ localStorage だけに保存する */
  const remote = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(ws);
  latest.current = ws;

  useEffect(() => {
    let cancelled = false;
    const done = () => !cancelled && setReady(true);
    if (backend.kind !== "server") {
      done();
      return;
    }
    fetch("/api/workspace")
      .then(async (res) => {
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
        const data = normalizeWorkspace(await res.json(), latest.current);
        remote.current = true;
        if (!cancelled) setWs(data);
      })
      .catch(() => undefined)
      .finally(done);
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const flush = useCallback(() => {
    const cur = latest.current;
    writeLocal(backend.name, cur);
    if (!remote.current) return;
    void fetch("/api/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cur),
    })
      .then((res) => {
        if (res.status === 404) remote.current = false;
      })
      .catch(() => undefined);
  }, [backend]);

  /** 一部の項目を書き換える。保存は 400ms 後にまとめて行う */
  const patch = useCallback(
    (p: Partial<WorkspaceState> | ((w: WorkspaceState) => Partial<WorkspaceState>)) => {
      setWs((w) => normalizeWorkspace(typeof p === "function" ? p(w) : p, w));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 400);
    },
    [flush],
  );

  // 閉じる前に、まだ保存していない変更を書き出す
  useEffect(() => {
    const onHide = () => {
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
        flush();
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      onHide();
    };
  }, [flush]);

  return { ws, patch, ready };
}

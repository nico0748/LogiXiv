import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, subscribe, type Health, type PaperDocument, type Sentence } from './api.ts';
import { PdfPane } from './PdfPane.tsx';
import { Sidebar } from './Sidebar.tsx';
import { GlossaryPanel } from './GlossaryPanel.tsx';
import { ReparsePanel } from './ReparsePanel.tsx';
import { TranslatePanel } from './TranslatePanel.tsx';

interface Props {
  documentId: string;
  onBack: () => void;
}

/**
 * SSE の合体待ち時間。
 *
 * Claude が MCP で連続翻訳すると 1 文ごとにイベントが飛ぶ。イベント 1 件ごとに
 * 文書全体（全文＋全訳＋全座標）を取り直していた頃は、リーダーを開いているだけで
 * 100 文の書き込みが 3.3 秒 → 20.6 秒に伸びていた。取りこぼしても次の合体で
 * 最新に追いつくので、まとめて 1 回にする。
 */
const RELOAD_DEBOUNCE_MS = 300;

/**
 * SSE が切れてから「届いていません」と言い出すまでの猶予。
 *
 * 本体を起動し直すのは普通に起きることで、EventSource は数秒で勝手に張り直す。
 * 切れた瞬間に警告を出すと、直るころには読んだ人の信用だけが減っている。
 * 逆に黙ったままだと、古い内容を最新だと思って読み続けることになる。
 */
const CONNECTION_GRACE_MS = 5000;

/** 書き出した Blob URL を手放すまでの猶予。押した直後に消すと保存が始まらない。 */
const OBJECT_URL_TTL_MS = 60_000;

/** 「この文書はもう無い」と言い切れる失敗か。 */
function isMissingDocument(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404 && /文書が見つかりません/.test(cause.message);
}

/**
 * 本体が「この文書は書き出せない」と教えてくれていたら、その理由を拾う。
 *
 * 書き出せるかどうかは取り込んだ時点で分かる（PDF の大きさで決まる）ので、
 * 本体は GET /api/documents/:id に情報を添えてくる。いまの形は
 * `exportability: { exportable: boolean, reason: string | null, ... }` だが、
 * この画面はそれを型として当てにしない — 本体側は別の作業で動いている最中で、
 * 名前が変わっても画面が黙って壊れてはいけない。unknown として読み、
 * 想定した形でなければ「何も言われていない」として扱う。**来ていなくても
 * 壊れない**ことを優先する — 分からなければ、従来どおり押して確かめられる。
 */
function readExportBlock(paper: PaperDocument): string | null {
  const record = paper as unknown as Record<string, unknown>;
  // 見る範囲は、文書の直下と「名前に export を含む入れ物」の中まで。
  const scopes: Record<string, unknown>[] = [record];
  for (const [key, value] of Object.entries(record)) {
    if (!/export/i.test(key)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      scopes.push(value as Record<string, unknown>);
    }
  }
  for (const scope of scopes) {
    const isRoot = scope === record;
    let blocked = false;
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value !== 'boolean') continue;
      // 直下では export を名前に含む鍵しか見ない（ok や applied を巻き込まないため）。
      if (isRoot && !/export/i.test(key)) continue;
      const negative = /(toolarge|too_large|blocked|disabled|refused|oversize)/i.test(key);
      const positive = /export(able|ok)?$|^(ok|allowed|available)$/i.test(key);
      if (negative && value) blocked = true;
      else if (positive && !negative && value === false) blocked = true;
    }
    if (!blocked) continue;
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value === 'string' && value.trim().length > 0 && /reason|message|note|error|detail|why/i.test(key)) {
        return value.slice(0, 300);
      }
    }
    return 'この文書は 1 ファイルに書き出せません（PDF が大きすぎます）。';
  }
  return null;
}

/**
 * 区切りを直した結果を、画面から見て分かる言葉にする。
 *
 * 黙って終わらせてはいけない。訳やメモが付いた文を結合すると、その注釈は
 * どの文にも結び付かなくなって画面から消える。消したわけではなく戻せるのだが、
 * 何も言わないと「作業が消えた」としか見えない。
 */
function describeEdit(
  label: string,
  result: { occurrences: number; detached?: { translations: number; notes: number; skipped: number } },
): string | null {
  const parts: string[] = [];
  if (result.occurrences > 1) parts.push(`同じ本文の ${result.occurrences} か所に適用しました`);
  const detached = result.detached;
  const lost: string[] = [];
  if (detached && detached.translations > 0) lost.push(`訳 ${detached.translations} 件`);
  if (detached && detached.notes > 0) lost.push(`メモ ${detached.notes} 件`);
  if (detached && detached.skipped > 0) lost.push(`「訳さない」${detached.skipped} 件`);
  if (lost.length > 0) {
    parts.push(`${lost.join('・')}が元の文から外れました（「直前の区切りを戻す」で戻ります）`);
  }
  return parts.length === 0 ? null : `${label}しました。${parts.join('。')}`;
}

function describeImport(result: {
  report: unknown;
  note: string;
  warning: string | null;
}): string {
  const report = result.report as Record<string, unknown> | null;
  const n = (key: string): number => (typeof report?.[key] === 'number' ? (report[key] as number) : 0);
  const base = report
    ? `取り込み完了: 訳 +${n('translationsAdded')} / 更新 ${n('translationsUpdated')} / メモ +${n('notesAdded')} / 対応なし ${n('orphaned')}${
        n('sentenceEditsAdopted') ? ` / 区切りの直し ${n('sentenceEditsAdopted')} 件を反映` : ''
      }${
        // 用語集は「これから訳すときの方針」なので、混ざると以後の訳が黙って従う。
        // 件数だけでは何が入ったか分からず取り消せないので、語そのものを出す。
        Array.isArray(report['glossaryAddedTerms']) && report['glossaryAddedTerms'].length > 0
          ? ` / 用語集 +${(report['glossaryAddedTerms'] as string[]).length}（${(report['glossaryAddedTerms'] as string[])
              .slice(0, 5)
              .join('・')}${(report['glossaryAddedTerms'] as string[]).length > 5 ? ' ほか' : ''}）`
          : ''
      }${
        // 相手の「訳さない」は、自分の残件をその数だけ減らす。黙って減らすと
        // 「訳していない文を抱えたまま翻訳完了」が成立する。
        n('skippedAdded') > 0 ? ` / 訳さない +${n('skippedAdded')}（残件がその数だけ減ります）` : ''
      }${
        n('detachedTranslations') + n('detachedNotes') > 0
          ? `（区切りが変わったため、こちらの訳 ${n('detachedTranslations')} 件・メモ ${n('detachedNotes')} 件が元の文から外れました）`
          : ''
      }`
    : result.note;
  return result.warning ? `${base}（${result.warning}）` : base;
}

export function Reader({ documentId, onBack }: Props): React.JSX.Element {
  const [paper, setPaper] = useState<PaperDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [zoom, setZoom] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [reparseOpen, setReparseOpen] = useState(false);
  /** 一致率で断られた取り込み。人が「それでも」と言ったときだけ通す。 */
  const [importConfirm, setImportConfirm] = useState<{ file: File; message: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  /** 直近に訳が届いた時刻。「いま Claude が書いている」を画面に出すため。 */
  const [lastWriteAt, setLastWriteAt] = useState<number | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  /**
   * この文書がもう無いと分かったときの理由。
   *
   * 別の窓や MCP から消された文書を、開きっぱなしのリーダーはそのまま表示し続け、
   * 訳の編集まで開けていた。保存して初めて「文書が見つかりません」と出るので、
   * 打ち直した訳はその時点で行き場が無い。無いと分かった時点で書ける状態をやめる。
   */
  const [gone, setGone] = useState<string | null>(null);
  /**
   * SSE が切れているか。切れている間の更新は画面に届かない。
   * 一瞬の切断では立てない（CONNECTION_GRACE_MS を参照）。
   */
  const [disconnected, setDisconnected] = useState(false);
  /** 書き出しで作った Blob URL。解放し損ねないよう手元で持つ。 */
  const objectUrls = useRef<string[]>([]);

  /** どちら側から選んだか。選んだ側はスクロールさせない。 */
  const [pdfScrollTarget, setPdfScrollTarget] = useState<{ id: string; token: number } | null>(null);
  const [sidebarScrollTarget, setSidebarScrollTarget] = useState<{ id: string; token: number } | null>(null);
  const selectionToken = useRef(0);

  /**
   * 選んだ側はスクロールさせない（自分で押した場所が動くと目が迷う）。
   * ただしキーボードで動かしたときは**どちらも**動かす。選んだのはカードではなく
   * 「次の文」なので、押した側という概念が無い。ここを sidebar 扱いにしていたため、
   * j を押しても訳の側だけが画面外へ流れていき、8 回で見えなくなっていた。
   */
  const select = useCallback((id: string, origin: 'pdf' | 'sidebar' | 'keyboard') => {
    setSelectedId(id);
    selectionToken.current += 1;
    const token = selectionToken.current;
    if (origin !== 'sidebar') setSidebarScrollTarget({ id, token });
    if (origin !== 'pdf') setPdfScrollTarget({ id, token });
  }, []);

  const reload = useCallback(async () => {
    try {
      setPaper(await api.getDocument(documentId));
      setError(null);
      setGone(null);
    } catch (cause) {
      // 一度読めた文書があると、以後の失敗は画面のどこにも出ていなかった
      // （`error && !paper` でしか出していなかった）。404 だけは握り潰さない。
      if (isMissingDocument(cause)) setGone(cause instanceof Error ? cause.message : String(cause));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
    void api.health().then(setHealth).catch(() => setHealth(null));
  }, [reload]);

  // 書き出しの Blob URL は、猶予で消し損ねたぶんも画面を出るときに必ず手放す。
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
    };
  }, []);

  // 「訳す」を開いている間だけ health を取り直す。この画面は
  // 「Claude とつながったか」を待つ画面なので、待っている値が
  // 更新されないと、待てばいいのか設定が悪いのか分からないまま止まる。
  useEffect(() => {
    if (!translateOpen) return;
    const timer = setInterval(() => {
      void api.health().then(setHealth).catch(() => {
        /* 本体が一瞬落ちても、次の周期で戻る。表示は前の値のままでよい。 */
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [translateOpen]);

  // MCP 経由で Claude が書いた訳を、リロードせずに反映する。
  // あわせて「この文書が消えた」「更新が届かなくなった」も、ここで受け取る。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(
      (event) => {
        if (event.documentId !== documentId) return;
        // 削除は取りこぼさない。受け取っておきながら何もしていなかったので、
        // 消えた文書に訳を書き続けられる状態がそのまま残っていた。
        if (event.type === 'document.deleted') {
          if (timer) clearTimeout(timer);
          setGone(`文書が見つかりません: ${documentId}`);
          return;
        }
        if (event.type === 'translation.updated' || event.type === 'document.updated') {
          setLastWriteAt(Date.now());
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
      },
      undefined,
      (status) => {
        if (status === 'open') {
          // 戻ったら黙って回復する。切れている間の更新は届いていないので、
          // 取り直してから警告を下ろす（古い内容のまま「正常」に見せない）。
          if (grace) clearTimeout(grace);
          grace = null;
          setDisconnected(false);
          void reload();
          return;
        }
        // 切れた瞬間には出さない。本体の再起動は普通に起きて、数秒で戻る。
        if (grace) return;
        grace = setTimeout(() => {
          grace = null;
          setDisconnected(true);
        }, CONNECTION_GRACE_MS);
      },
    );
    return () => {
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      unsubscribe();
    };
  }, [documentId, reload]);

  const notesByHash = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!paper) return map;
    for (const note of paper.annotations.notes) {
      const list = map.get(note.sentenceHash);
      if (list) list.push(note.body);
      else map.set(note.sentenceHash, [note.body]);
    }
    return map;
  }, [paper]);

  const visibleSentences: Sentence[] = useMemo(() => {
    if (!paper) return [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return paper.structure.sentences;
    return paper.structure.sentences.filter((sentence) => {
      const haystack = [
        sentence.text,
        paper.annotations.translations[sentence.hash]?.text ?? '',
        ...(notesByHash.get(sentence.hash) ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [paper, filter, notesByHash]);

  const visibleIds = useMemo(
    () => (filter.trim().length === 0 ? null : new Set(visibleSentences.map((s) => s.id))),
    [filter, visibleSentences],
  );

  /**
   * 文から文へキーで移動する。
   *
   * 1 文ずつ読む道具なのに 1 文ずつ動かす手段が無く、300 文の論文は
   * 300 回クリックする作業になっていた。読み進める操作が重い道具は、
   * 2 本目の論文で開かれない。
   *
   * j/k と ↓/↑ が 1 文、n が「次の未訳」。入力欄にいるときは何もしない。
   */
  const move = useCallback(
    (step: 1 | -1 | 'next-untranslated') => {
      if (!paper) return;
      const list = visibleSentences.length > 0 ? visibleSentences : paper.structure.sentences;
      if (list.length === 0) return;
      const at = selectedId === null ? -1 : list.findIndex((sentence) => sentence.id === selectedId);
      let target: Sentence | undefined;
      if (step === 'next-untranslated') {
        const skipped = paper.annotations.skipped ?? {};
        const needs = (sentence: Sentence): boolean =>
          !paper.annotations.translations[sentence.hash] && !skipped[sentence.hash];
        target = list.slice(at + 1).find(needs) ?? list.find(needs);
      } else {
        target = list[Math.min(Math.max(at + step, 0), list.length - 1)];
      }
      if (target) select(target.id, 'keyboard');
    },
    [paper, visibleSentences, selectedId, select],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // 文字を打っている最中は横取りしない。
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const step =
        event.key === 'j' || event.key === 'ArrowDown'
          ? (1 as const)
          : event.key === 'k' || event.key === 'ArrowUp'
            ? (-1 as const)
            : event.key === 'n'
              ? ('next-untranslated' as const)
              : null;
      if (step === null) return;
      event.preventDefault();
      move(step);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  const stats = useMemo(() => {
    if (!paper) return null;
    // 訳は「異なり文」単位で付く。文の総数を分母にすると 100% にならない。
    const hashes = new Set(paper.structure.sentences.map((s) => s.hash));
    const skipped = paper.annotations.skipped ?? {};
    let translated = 0;
    let skippedCount = 0;
    for (const hash of hashes) {
      if (paper.annotations.translations[hash]) translated++;
      else if (skipped[hash]) skippedCount++;
    }
    return {
      total: hashes.size,
      translated,
      skipped: skippedCount,
      // サイドバーに並ぶのは延べ数。異なり文より多いと、数えて合わないのが見える。
      occurrences: paper.structure.sentences.length,
    };
  }, [paper]);

  /**
   * 失敗を黙って捨てないための共通ラッパ。以前は保存に失敗しても画面が無反応だった。
   *
   * ここだけは描画のたびに作り直さない（useCallback）。サイドバーのカードは
   * props を値で比べて再描画を省くので、渡す関数が毎回別物だと比較が必ず外れ、
   * 1 打ごとに全カードが作り直されてしまう。
   */
  const run = useCallback(
    async (label: string, task: () => Promise<string | null>): Promise<boolean> => {
      // 前の操作の知らせを消してから始める。残しておくと、次の操作の結果として読まれる。
      setMessage(null);
      setBusyAction(label);
      try {
        const note = await task();
        if (note) setMessage(note);
        return true;
      } catch (cause) {
        // 相手の文書が消えているなら、そう言う。失敗の文言だけ出しても、
        // 次の操作でまた同じところまで書かせて同じように失敗する。
        if (isMissingDocument(cause)) setGone(cause instanceof Error ? cause.message : String(cause));
        setMessage(`${label}に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const saveTranslation = useCallback(
    (hash: string, text: string): Promise<boolean> =>
      run('訳の保存', async () => {
        const result = await api.setTranslation(documentId, hash, text);
        await reload();
        if (!result.applied) throw new Error(result.reason ?? '保存されませんでした');
        return null;
      }),
    [run, documentId, reload],
  );

  /**
   * 区切りを直したあとの後始末。
   *
   * 読み直したうえで、できた文を選び直す。区切りを変えると文の ID が変わるので、
   * 何もしないと今いじっていた場所の選択が外れ、長い論文では読んでいた位置を見失う。
   */
  const applyEdit = useCallback(
    async (result: { applied: boolean; resultHashes?: string[] }): Promise<void> => {
      const updated = await api.getDocument(documentId).catch(() => null);
      if (updated) {
        setPaper(updated);
        setError(null);
        const wanted = result.resultHashes?.[0];
        const landed = wanted ? updated.structure.sentences.find((s) => s.hash === wanted) : undefined;
        if (landed) select(landed.id, 'sidebar');
      } else {
        await reload();
      }
    },
    [documentId, reload, select],
  );

  const runImport = useCallback(
    (file: File, force = false): Promise<boolean> =>
      run('取り込み', async () => {
        const html = await file.text();
        try {
          const result = await api.importHtml(documentId, html, force);
          await reload();
          return describeImport(result);
        } catch (cause) {
          // 一致率が低くて断られたときは、やり直す道を出す。素のエラーにすると
          // 「取り込めません」で終わってしまい、同じ論文の版違いも通せなくなる。
          if (cause instanceof ApiError && cause.status === 400 && /一致率/.test(cause.message)) {
            setImportConfirm({ file, message: cause.message });
            return null;
          }
          throw cause;
        }
      }),
    [run, documentId, reload],
  );

  /**
   * 書き出し。リンク（<a download>）ではなく、取得してからファイルにする。
   *
   * 本体は上限を超える PDF に 413 と日本語の理由を返しているのに、リンクでは
   * その本文がどこにも出ない。ブラウザは export.json（＝エラー JSON）を
   * 落としかけて黙って取り消すだけで、押した人からはボタンが効いていないのと
   * 見分けが付かなかった。取得にしておけば、失敗はいつもの flash に出せる。
   *
   * 数十 MB を組み立てるので数秒〜十数秒かかる。その間 busyAction が立つので、
   * ボタンは「書き出し中…」になり、押したことが画面に残る。
   */
  const runExport = useCallback(
    (): Promise<boolean> =>
      run('書き出し', async () => {
        const { blob, fileName } = await api.exportDocument(documentId);
        const url = URL.createObjectURL(blob);
        objectUrls.current.push(url);
        const link = window.document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        // 押した直後に解放すると保存が始まらないことがあるので、猶予を置いてから捨てる。
        // 捨てないと、書き出したファイルぶんのメモリを画面が掴んだままになる。
        setTimeout(() => {
          URL.revokeObjectURL(url);
          // 配列そのものは作り直さない（画面を出るときの後始末が、古い配列を見てしまう）。
          const at = objectUrls.current.indexOf(url);
          if (at >= 0) objectUrls.current.splice(at, 1);
        }, OBJECT_URL_TTL_MS);
        return `${fileName}（${(blob.size / 1024 / 1024).toFixed(1)}MB）を書き出しました。`;
      }),
    [run, documentId],
  );

  const addNote = useCallback(
    (hash: string, body: string): Promise<boolean> =>
      run('メモの追加', async () => {
        await api.addNote(documentId, hash, body);
        await reload();
        return null;
      }),
    [run, documentId, reload],
  );

  const deleteNote = useCallback(
    (noteId: string): Promise<boolean> =>
      run('メモの削除', async () => {
        await api.deleteNote(documentId, noteId);
        await reload();
        return null;
      }),
    [run, documentId, reload],
  );

  const mergeWithNext = useCallback(
    (hashes: [string, string]): Promise<boolean> =>
      run('文の結合', async () => {
        const result = await api.mergeSentences(documentId, hashes);
        await applyEdit(result);
        if (!result.applied) throw new Error(result.reason ?? '結合できませんでした');
        return describeEdit('結合', result);
      }),
    [run, documentId, applyEdit],
  );

  const splitSentence = useCallback(
    (hash: string, offsets: number[]): Promise<boolean> =>
      run('文の分割', async () => {
        const result = await api.splitSentence(documentId, hash, offsets);
        await applyEdit(result);
        if (!result.applied) throw new Error(result.reason ?? '分割できませんでした');
        return describeEdit('分割', result);
      }),
    [run, documentId, applyEdit],
  );

  const toggleSkip = useCallback(
    (hash: string, skip: boolean): Promise<boolean> =>
      run(skip ? '訳さない設定' : '訳す対象への復帰', async () => {
        if (skip) await api.skipSentence(documentId, hash);
        else await api.unskipSentence(documentId, hash);
        await reload();
        return null;
      }),
    [run, documentId, reload],
  );

  const deleteTranslation = useCallback(
    (hash: string, alsoSkip: boolean): Promise<boolean> =>
      run('訳の削除', async () => {
        const result = await api.deleteTranslation(documentId, hash, alsoSkip);
        await reload();
        if (!result.deleted) return '訳はもうありませんでした。';
        return result.skipped ? '訳を消して、訳す対象から外しました。' : '訳を消しました。';
      }),
    [run, documentId, reload],
  );

  /**
   * もう無い文書に書き続けられる状態を作らない。
   *
   * ここを出さずにいたので、別の窓（や MCP）で消された文書を開いたままの
   * リーダーは何事も無かったように表示し、訳の編集まで開けた。打ち直した訳は
   * 保存を押した瞬間に行き場を失う。読むだけなら害が無い、とは言えない。
   */
  if (gone) {
    return (
      <div className="pane-message" role="alert">
        <p>
          <strong>この文書はもうありません。</strong>
          別の窓か Claude（MCP）から削除されたようです。ここで編集しても保存できません。
        </p>
        <p className="hint">{gone}</p>
        <button type="button" onClick={onBack}>
          一覧へ戻る
        </button>
      </div>
    );
  }
  if (error && !paper) {
    return (
      <div className="pane-message">
        {error}{' '}
        <button type="button" onClick={onBack}>
          一覧へ戻る
        </button>
      </div>
    );
  }
  if (!paper || !stats) return <div className="pane-message">読み込んでいます…</div>;

  const remaining = stats.total - stats.translated - stats.skipped;

  // 本体が教えてくれていれば、押す前に「書き出せない」と分かる。
  // 教えてくれていなければ null なので、これまでどおり押して確かめることになる。
  const exportBlock = readExportBlock(paper);

  return (
    <div className="reader">
      <header className="toolbar">
        <button type="button" onClick={onBack}>
          ← 一覧
        </button>
        {/* 自動で当てた題名は外れることがある。推測を賢くするより直せる方が確実。 */}
        {renaming ? (
          <input
            className="toolbar-title-input"
            defaultValue={paper.title}
            autoFocus
            aria-label="題名"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRenaming(false);
              if (event.key !== 'Enter') return;
              const value = (event.target as HTMLInputElement).value;
              void run('題名の変更', async () => {
                await api.renameDocument(documentId, value);
                await reload();
                setRenaming(false);
                return null;
              });
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            className="toolbar-title"
            title={`${paper.title}（押すと題名を直せます）`}
            onClick={() => setRenaming(true)}
          >
            {paper.title}
          </button>
        )}
        <span className={`badge${paper.structure.parser === 'grobid' ? ' is-good' : ' is-warn'}`}>
          {paper.structure.parser === 'grobid' ? 'GROBID 解析' : '簡易解析'}
        </span>
        {/* 訳は「異なり文」に付くので分母はその数。ところがサイドバーには
            延べで並ぶので、数が合わないように見える（202 文と言いながら 273 行）。
            食い違うときだけ、延べの数も一緒に出して種明かしをする。 */}
        <span
          className="toolbar-progress"
          title={
            stats.occurrences > stats.total
              ? `同じ本文の文が ${stats.occurrences - stats.total} 回くり返されています。訳は本文ごとに 1 つ付き、出てくる全部に反映されます。`
              : '訳は同じ本文ごとに 1 つ付きます'
          }
        >
          {stats.translated} / {stats.total} 文
          {stats.occurrences > stats.total && `（画面には延べ ${stats.occurrences} 行）`}
          {stats.skipped > 0 && `（訳さない ${stats.skipped}）`}
        </span>

        {/* 翻訳の始め方は、手順書ではなく画面に置く。ここが無いと、
            取り込んだ直後の利用者には次にすることが何も見えない。 */}
        <button
          type="button"
          className={`is-primary${remaining > 0 ? ' is-calling' : ''}`}
          aria-expanded={translateOpen}
          onClick={() => setTranslateOpen((open) => !open)}
        >
          {remaining > 0 ? `訳す（残り ${remaining}）` : '翻訳の設定'}
        </button>

        <input
          className="toolbar-search"
          type="search"
          value={filter}
          placeholder="原文・訳文・メモを検索"
          aria-label="文書内検索"
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="toolbar-zoom">
          <button
            type="button"
            aria-label="縮小"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
          >
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="拡大"
            onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.1) * 10) / 10))}
          >
            ＋
          </button>
        </div>

        {(paper.annotations.sentenceEdits?.length ?? 0) > 0 && (
          <button
            type="button"
            disabled={busyAction !== null}
            title={`直前の結合・分割を 1 件だけ取り消します（記録は ${
              paper.annotations.sentenceEdits?.length ?? 0
            } 件）`}
            onClick={() =>
              void run('区切りの取り消し', async () => {
                const result = await api.undoSentenceEdit(documentId);
                await reload();
                if (!result.applied) throw new Error(result.reason ?? '取り消せませんでした');
                return '直前の区切りの変更を戻しました';
              })
            }
          >
            直前の区切りを戻す
          </button>
        )}

        <button type="button" aria-expanded={glossaryOpen} onClick={() => setGlossaryOpen((open) => !open)}>
          用語集{paper.annotations.glossary.length > 0 ? `（${paper.annotations.glossary.length}）` : ''}
        </button>

        {/* 書き出せないと本体が言っているときは、押す前に見えるようにする。 */}
        {exportBlock !== null && (
          <span className="badge is-warn" title={exportBlock}>
            書き出せません
          </span>
        )}
        <button
          type="button"
          disabled={busyAction !== null}
          title={exportBlock ?? '対訳・メモ・用語集と PDF を 1 つの HTML にまとめます'}
          onClick={() => void runExport()}
        >
          {busyAction === '書き出し' ? '書き出し中…' : '書き出し'}
        </button>
        <button type="button" disabled={busyAction !== null} onClick={() => importInput.current?.click()}>
          取り込み
        </button>
        <input
          ref={importInput}
          type="file"
          accept=".html,text/html"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void runImport(file);
            event.target.value = '';
          }}
        />
        <button type="button" disabled={busyAction !== null} onClick={() => setReparseOpen(true)}>
          {busyAction === '再解析' ? '再解析中…' : '再解析'}
        </button>
      </header>

      {importConfirm && (
        <div className="translate-panel" role="dialog" aria-label="取り込みの確認">
          <div className="translate-head">
            <strong>この書き出しを取り込みますか</strong>
            <button
              type="button"
              className="flash-close"
              aria-label="閉じる"
              onClick={() => setImportConfirm(null)}
            >
              ×
            </button>
          </div>
          <p className="translate-note reparse-caution">{importConfirm.message}</p>
          <p className="translate-note">
            別の論文の書き出しだと、訳は 1 件も当たらないまま
            <strong>用語集だけが混ざり</strong>、以後の訳がそれに従います。同じ論文の版違いなら、
            そのまま進めて構いません。
          </p>
          <div className="card-actions">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => {
                const { file } = importConfirm;
                setImportConfirm(null);
                void runImport(file, true);
              }}
            >
              それでも取り込む
            </button>
            <button type="button" onClick={() => setImportConfirm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}

      {reparseOpen && (
        <ReparsePanel
          document={paper}
          grobidUp={health?.grobid === 'up'}
          busy={busyAction === '再解析'}
          onClose={() => setReparseOpen(false)}
          onRun={async (parser) => {
            const before = paper.structure.parser;
            await run('再解析', async () => {
              const result = await api.reparse(documentId, parser);
              await reload();
              setReparseOpen(false);
              const edits =
                result.editsReapplied > 0 || result.editsDropped > 0
                  ? ` / 区切りの直し ${result.editsReapplied} 件を再適用${
                      // 「解除」と書いていた頃、記録も一緒に消えていたので
                      // 「元の方式に戻せば戻る」という同じ行の案内が嘘になっていた。
                      // いまは記録が残るので、戻せば効き直す。
                      result.editsDropped > 0
                        ? `・${result.editsDropped} 件は本文が変わったため外れた状態（記録は残っています）`
                        : ''
                    }`
                  : '';
              // 「対応なし n 件」だけでは、消えたのか外れただけなのかが分からない。
              // 戻し方まで書く（ここが分からないと、訳を作り直すしかなくなる）。
              const orphanNote =
                result.orphaned > 0
                  ? `。外れた訳は消えていません — 「再解析」から${
                      before === 'grobid' ? 'GROBID' : '簡易解析'
                    }を選び直すと戻ります`
                  : '';
              return `再解析しました（訳の再結合 ${result.rebound} 件 / 対応なし ${result.orphaned} 件${edits}）${orphanNote}${
                result.warning ? ` — ${result.warning}` : ''
              }`;
            });
          }}
        />
      )}

      {translateOpen && (
        <TranslatePanel
          health={health}
          documentTitle={paper.title}
          remaining={remaining}
          lastWriteAt={lastWriteAt}
          onClose={() => setTranslateOpen(false)}
        />
      )}

      {glossaryOpen && (
        <GlossaryPanel
          document={paper}
          onChanged={reload}
          onClose={() => setGlossaryOpen(false)}
          onMessage={setMessage}
        />
      )}

      <p className="parser-note">
        {paper.structure.parserNote}
        <span className="parser-keys"> ／ j・k（↓↑）で文を移動、n で次の未訳へ</span>
      </p>
      {disconnected && (
        <p className="flash is-warn" role="status" aria-live="polite">
          本体とのつながりが切れています。ここから先の更新はこの画面に届きません（保存もできません）。
          つなぎ直しは続けているので、本体が戻れば黙って最新に追いつきます。
        </p>
      )}
      {message && (
        <p className="flash" role="status" aria-live="polite">
          {message}
          <button type="button" className="flash-close" aria-label="閉じる" onClick={() => setMessage(null)}>
            ×
          </button>
        </p>
      )}

      <div className="reader-body">
        <PdfPane
          document={paper}
          selectedId={selectedId}
          onSelect={select}
          visibleSentenceIds={visibleIds}
          zoom={zoom}
          scrollTarget={pdfScrollTarget}
        />
        <Sidebar
          document={paper}
          selectedId={selectedId}
          filter={filter}
          visibleSentences={visibleSentences}
          onSelect={select}
          scrollTarget={sidebarScrollTarget}
          onSaveTranslation={saveTranslation}
          onAddNote={addNote}
          onDeleteNote={deleteNote}
          onMergeWithNext={mergeWithNext}
          onSplit={splitSentence}
          onToggleSkip={toggleSkip}
          onDeleteTranslation={deleteTranslation}
        />
      </div>
    </div>
  );
}

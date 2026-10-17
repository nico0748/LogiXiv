import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocument, STRUCTURE_VERSION, type DocumentStructure } from '@paperlens/core';
import { loadConfig } from '../src/config.ts';
import { DocumentStore } from '../src/store.ts';

/**
 * 新規文書の置き方。書きかけの置き場が一覧に「開けません」の行として現れないこと。
 */

const structure: DocumentStructure = {
  version: STRUCTURE_VERSION,
  parser: 'grobid',
  parserNote: 'test',
  parsedAt: new Date(0).toISOString(),
  title: 'Staging Test',
  abstract: null,
  pageSizes: [{ page: 1, width: 600, height: 800 }],
  sections: [],
  sentences: [],
};

async function withStore(body: (store: DocumentStore, dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperlens-store-create-'));
  const store = new DocumentStore(loadConfig({ dataDir }));
  try {
    await store.init();
    await body(store, dataDir);
  } finally {
    await store.releaseLock();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('create は PDF と document.json を書き切ってから置き、staging を残さない', async () => {
  await withStore(async (store, dataDir) => {
    const document = createDocument({ structure, sourceFileName: 'a.pdf' });
    await store.create(document, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await access(join(dataDir, 'documents', document.id, 'document.json'));
    await access(join(dataDir, 'documents', document.id, 'source.pdf'));
    assert.deepEqual(await readdir(join(dataDir, 'documents')), [document.id]);
    assert.equal((await store.list()).length, 1);
    assert.equal(store.unreadable.size, 0);
  });
});

test('create の直前の確認が投げたら、置かずに staging も消す', async () => {
  await withStore(async (store, dataDir) => {
    const document = createDocument({ structure, sourceFileName: 'b.pdf' });
    await assert.rejects(
      store.create(document, new Uint8Array([0x25]), () => {
        throw new Error('client gone');
      }),
      /client gone/,
    );
    assert.deepEqual(await readdir(join(dataDir, 'documents')), []);
    assert.equal((await store.list()).length, 0);
  });
});

test('. で始まる置き場（書きかけ）は、一覧にも「開けません」にも出ない', async () => {
  await withStore(async (store, dataDir) => {
    const staging = join(dataDir, 'documents', '.staging-doc_x');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'source.pdf'), 'x');
    assert.equal((await store.list()).length, 0);
    assert.equal(store.unreadable.size, 0);
  });
});

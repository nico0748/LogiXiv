import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultDataDir, loadConfig } from '../src/config.ts';
import { DataDirectoryLockedError, DocumentStore } from '../src/store.ts';

/**
 * LogiXiv → PaperLens の改名で、既存の設定とデータ置き場が黙って使えなくならないこと。
 */

const ENV_NAMES = [
  'PAPERLENS_SERVER_PORT',
  'PAPERLENS_SERVER_HOST',
  'PAPERLENS_SERVER_DATA_DIR',
  'PAPERLENS_GROBID_URL',
  'LOGIXIV_PORT',
  'LOGIXIV_HOST',
  'LOGIXIV_DATA_DIR',
  'LOGIXIV_GROBID_URL',
  // アプリ（apps/reader）側の名前。こちらの設定に混ざらないことを確かめる。
  'PAPERLENS_PORT',
  'PAPERLENS_DATA',
];

function withEnv(values: Record<string, string>, body: () => void): void {
  const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('改名前の LOGIXIV_* 環境変数も読む', () => {
  withEnv(
    { LOGIXIV_PORT: '5001', LOGIXIV_HOST: '127.0.0.2', LOGIXIV_DATA_DIR: '/tmp/old-dir', LOGIXIV_GROBID_URL: 'http://g:1/' },
    () => {
      const config = loadConfig();
      assert.equal(config.port, 5001);
      assert.equal(config.host, '127.0.0.2');
      assert.equal(config.dataDir, '/tmp/old-dir');
      assert.equal(config.grobidUrl, 'http://g:1');
    },
  );
});

test('新しい PAPERLENS_SERVER_* が古い名前より優先される', () => {
  withEnv({ LOGIXIV_PORT: '5001', PAPERLENS_SERVER_PORT: '5002', LOGIXIV_GROBID_URL: 'http://old', PAPERLENS_GROBID_URL: 'http://new' }, () => {
    const config = loadConfig();
    assert.equal(config.port, 5002);
    assert.equal(config.grobidUrl, 'http://new');
  });
});

test('アプリの PAPERLENS_PORT / PAPERLENS_DATA はこのサーバーの設定に効かない', () => {
  withEnv({ PAPERLENS_PORT: '5175', PAPERLENS_DATA: '/tmp/app-vault' }, () => {
    const config = loadConfig();
    assert.equal(config.port, 4173);
    assert.notEqual(config.dataDir, '/tmp/app-vault');
  });
});

test('既定のデータ置き場は、新しい側が無く ~/.logixiv だけあればそちらを使う', async () => {
  const home = await mkdtemp(join(tmpdir(), 'paperlens-home-test-'));
  try {
    assert.equal(defaultDataDir(home), join(home, '.paperlens-server'));
    await mkdir(join(home, '.logixiv'));
    assert.equal(defaultDataDir(home), join(home, '.logixiv'));
    await mkdir(join(home, '.paperlens-server'));
    assert.equal(defaultDataDir(home), join(home, '.paperlens-server'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('改名前の版が持っているロック（logixiv.lock）があれば開かない', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperlens-lock-test-'));
  try {
    // 生きている別プロセスの PID として親プロセスを使う。
    await writeFile(join(dataDir, 'logixiv.lock'), `${process.ppid}\n`);
    const store = new DocumentStore(loadConfig({ dataDir }));
    await assert.rejects(store.init(), DataDirectoryLockedError);

    // 持ち主が居ない古いロックは邪魔しない。新しいロックは paperlens.lock。
    await writeFile(join(dataDir, 'logixiv.lock'), '999999999\n');
    const fresh = new DocumentStore(loadConfig({ dataDir }));
    await fresh.init();
    await access(join(dataDir, 'paperlens.lock'));
    await fresh.releaseLock();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

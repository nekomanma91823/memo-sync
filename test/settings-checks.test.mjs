import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHROME_SYNC_SAFE_BYTES,
  backupMemoRows,
  chromeSyncBytes,
  chromeSyncFit,
  liveImageCount,
  otherSyncBytes,
  restoreSummary,
} from '../extension/lib/settings-checks.js';
import { createChromeSyncBackend } from '../extension/lib/chrome-sync.js';
import { isExportText } from '../extension/lib/backup-format.js';
import { chromeSyncArea } from './fakes.mjs';

const doc = (memos, extra = {}) => ({
  order: Object.keys(memos),
  orderUpdatedAt: 5,
  memos,
  images: {},
  ...extra,
});

test('Chrome 同期に切り替えたときの大きさは、実際に書く大きさと同じ', async () => {
  const area = chromeSyncArea();
  const backend = createChromeSyncBackend(area);
  const d = doc({
    aaaa1: { text: 'あ'.repeat(5_000), updatedAt: 10, labelAt: 11, name: '長いメモ', hidden: true },
    bbbb2: { text: 'short', updatedAt: 12 },
    cccc3: { text: '', updatedAt: 13, deleted: true },
  });
  const remote = await backend.pull();
  await backend.push(d, remote, []);
  const written = await area.getBytesInUse(null);
  assert.equal(chromeSyncBytes(d), written);
});

test('メモ以外（グループの色など）の大きさだけを数える', () => {
  assert.equal(otherSyncBytes({ meta: { v: 1 }, 'h:a': {}, 'c:a:0': {} }), 0);
  assert.ok(otherSyncBytes({ groupColors: { 仕事: 'red' } }) > 0);
});

test('上限に近い大きさは切り替えさせない', () => {
  assert.equal(chromeSyncFit(10_000).fits, true);
  assert.equal(chromeSyncFit(CHROME_SYNC_SAFE_BYTES + 1).fits, false);
  assert.equal(chromeSyncFit(51_200).percent, 50);
  assert.equal(chromeSyncFit(1_025).kb, 2);
});

test('消していない画像だけを数える', () => {
  const d = doc(
    { aaaa1: { text: 'x', updatedAt: 1 }, bbbb2: { text: '', updatedAt: 2, deleted: true } },
    {
      images: {
        img1: { memoId: 'aaaa1', addedAt: 1 },
        img2: { memoId: 'aaaa1', addedAt: 2, deleted: true },
        img3: { memoId: 'bbbb2', addedAt: 3 },
      },
    },
  );
  assert.equal(liveImageCount(d), 1);
});

test('戻したときに変わるメモと、ゴミ箱に移るメモ（と画像）を数える', () => {
  const now = doc(
    {
      aaaa1: { text: '同じ', updatedAt: 1 },
      bbbb2: { text: '書き換えた', updatedAt: 2 },
      cccc3: { text: '後から作った', updatedAt: 3 },
    },
    { images: { img1: { memoId: 'cccc3', addedAt: 1 }, img2: { memoId: 'cccc3', addedAt: 2 } } },
  );
  const backup = {
    at: 1,
    memos: [
      { id: 'aaaa1', text: '同じ' },
      { id: 'bbbb2', text: '元の内容' },
      { id: 'dddd4', text: '消したメモ' },
    ],
  };
  assert.deepEqual(restoreSummary(backup, now), { memos: 3, changed: 2, removed: 1, removedImages: 2 });
});

test('重なったときのバックアップは、重なったメモを先に見せる', () => {
  const backup = { memos: [{ id: 'a1a1' }, { id: 'b2b2' }, { id: 'c3c3' }], conflicts: ['c3c3'] };
  assert.deepEqual(
    backupMemoRows(backup).map((row) => [row.memo.id, row.number, row.conflicted]),
    [
      ['c3c3', 3, true],
      ['a1a1', 1, false],
      ['b2b2', 2, false],
    ],
  );
  assert.equal(backupMemoRows({ memos: [{ id: 'a1a1' }] })[0].conflicted, false);
});

test('書き出したファイルの形かどうかを見分ける', () => {
  assert.equal(isExportText('memosync-export 1\n\n===== メモ 1 =====\n本文\n'), true);
  assert.equal(isExportText('\uFEFFmemosync-export 1\r\n\r\n===== メモ 1 =====\r\nこんにちは\r\n'), true);
  // ほかのアプリのバックアップや、見出しを書いただけのテキストは違う
  assert.equal(isExportText('memo-1\n\n本文\n\n---\n\n'), false);
  assert.equal(isExportText('ただのテキスト\n===== メモ 1 ====='), false);
});

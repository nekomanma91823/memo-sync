import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, createDevice, visible, visibleTexts } from './fakes.mjs';
import { MAX_MEMOS } from '../extension/lib/model.js';

async function device() {
  const d = createDevice({ clock: createClock() });
  await d.engine.ready();
  return d;
}

test('最初は空のメモが 3 つあり、同期方式は Chrome 同期', async () => {
  const d = await device();
  assert.deepEqual(await visibleTexts(d), ['', '', '']);
  assert.deepEqual((await d.local.get('settings')).settings, { mode: 'chrome' });
});

test('編集は画面の付けた時刻で保存され、時刻が戻っても新しい版になる', async () => {
  const d = await device();
  const { ids } = await visible(d);
  // 先の時刻は「今 + 1 分」までに抑える
  const first = await d.engine.edit(ids[0], 'a', 1_800_000_000_000);
  assert.ok(first.updatedAt < 1_700_000_000_000 + 61_000);
  const second = await d.engine.edit(ids[0], 'ab', 1);
  assert.equal(second.updatedAt, first.updatedAt + 1);
  assert.equal((await visibleTexts(d))[0], 'ab');
  assert.equal((await d.local.get('dirty')).dirty, true);
});

test('消されたメモに書き込むと生き返る', async () => {
  const d = await device();
  const { ids } = await visible(d);
  await d.engine.remove(ids[1]);
  await d.engine.edit(ids[1], 'まだ書いていた');
  const after = await visible(d);
  assert.deepEqual(after.ids, [ids[0], ids[2], ids[1]]);
  assert.equal(after.doc.memos[ids[1]].text, 'まだ書いていた');
});

test('最後の 1 つは削除できず、上限を超えて追加できない', async () => {
  const d = await device();
  const { ids } = await visible(d);
  await d.engine.remove(ids[0]);
  await d.engine.remove(ids[1]);
  await assert.rejects(d.engine.remove(ids[2]), /最後のメモ/);
  for (let i = 1; i < MAX_MEMOS; i++) await d.engine.add();
  await assert.rejects(d.engine.add(), /まで/);
});

test('文字のあるメモを削除するとバックアップが残り、そこから戻せる', async () => {
  const d = await device();
  const { ids } = await visible(d);
  await d.engine.edit(ids[0], '残したい');
  await d.engine.edit(ids[1], '二つ目');
  await d.engine.remove(ids[0]);
  const { backups } = await d.local.get('backups');
  assert.equal(backups[0].reason, 'remove');
  await d.engine.restore(backups[0].at);
  assert.deepEqual(await visibleTexts(d), ['残したい', '二つ目', '']);
});

test('取り込み：番号どおりに上書き と 末尾に追加', async () => {
  const d = await device();
  const { ids } = await visible(d);
  await d.engine.edit(ids[2], '3番目にあった');
  await d.engine.importItems([{ text: '一' }, { text: '二' }, { text: '' }, { text: '四' }], 'replace');
  assert.deepEqual(await visibleTexts(d), ['一', '二', '', '四']);
  await d.engine.importItems([{ text: '追加' }, { text: '  ' }], 'append');
  assert.deepEqual(await visibleTexts(d), ['一', '二', '', '四', '追加']);
  const { backups } = await d.local.get('backups');
  assert.ok(backups.some((b) => b.reason === 'import' && b.memos.some((m) => m.text === '3番目にあった')));
  await assert.rejects(d.engine.importItems([{ text: 1 }], 'append'), /不正/);
});

test('自動バックアップは 1 時間に 1 回まで、同じ内容は重ねて取らない', async () => {
  const clock = createClock();
  const d = createDevice({ clock });
  await d.engine.ready();
  const { ids } = await visible(d);
  await d.engine.edit(ids[0], 'x');
  await d.engine.autoBackup();
  await d.engine.autoBackup();
  assert.equal((await d.local.get('backups')).backups.length, 1);
  clock.advance(61 * 60 * 1000);
  await d.engine.autoBackup();
  assert.equal((await d.local.get('backups')).backups.length, 1);
  await d.engine.edit(ids[0], 'xy');
  clock.advance(61 * 60 * 1000);
  await d.engine.autoBackup();
  assert.equal((await d.local.get('backups')).backups.length, 2);
});

test('同期中の編集は次の同期に回り、未送信の印が残る', async () => {
  const d = await device();
  const { ids } = await visible(d);
  const original = d.engine.backends.chrome.pull;
  d.engine.backends.chrome.pull = async () => {
    await d.engine.edit(ids[0], '同期中に書いた');
    return original();
  };
  await d.engine.sync();
  assert.equal((await d.local.get('dirty')).dirty, true);
  d.engine.backends.chrome.pull = original;
  await d.engine.sync();
  assert.equal((await d.local.get('dirty')).dirty, false);
  assert.match(JSON.stringify([...d.sync.data.values()]), /同期中に書いた/);
});

test('タブを並べ替えると並び順が保存され、古い並びでの指示は断る', async () => {
  const d = await device();
  const { ids } = await visible(d);
  assert.equal(await d.engine.reorder([ids[2], ids[0], ids[1]]), true);
  assert.deepEqual((await visible(d)).ids, [ids[2], ids[0], ids[1]]);
  assert.equal(await d.engine.reorder([ids[2], ids[0], ids[1]]), false);
  await d.engine.remove(ids[1]);
  await assert.rejects(d.engine.reorder([ids[0], ids[1], ids[2]]), /もう一度/);
  await assert.rejects(d.engine.reorder([ids[0], ids[0]]), /もう一度/);
});

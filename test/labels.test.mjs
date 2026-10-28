// メモの名前・グループ・隠す印（ラベル）と、ドライブの使用量

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeSyncArea, createClock, createDevice, FakeDrive, visible } from './fakes.mjs';
import { groupNames, mergeDocs, sanitizeDoc } from '../extension/lib/model.js';
import { searchMemos } from '../extension/lib/search.js';

const doc = (memos) => ({ order: Object.keys(memos), orderUpdatedAt: 1, memos });

async function pair(mode) {
  const clock = createClock();
  const sync = chromeSyncArea();
  const drive = new FakeDrive();
  const a = createDevice({ sync, drive, clock });
  const b = createDevice({ sync, drive, clock });
  for (const d of [a, b]) {
    await d.engine.ready();
    if (mode === 'drive') await d.engine.setMode('drive');
  }
  await a.engine.sync();
  await b.engine.sync();
  return { a, b, clock };
}

test('本文とラベルはそれぞれ新しい方が残る（引数の順番によらない）', () => {
  const mine = doc({ aaaa: { text: '後から書いた本文', updatedAt: 9, labelAt: 2, name: '古い名前' } });
  const theirs = doc({ aaaa: { text: '前の本文', updatedAt: 3, labelAt: 7, name: '新しい名前', group: '仕事', hidden: true } });
  const merged = mergeDocs(mine, theirs).doc;
  assert.deepEqual(merged.memos.aaaa, { text: '後から書いた本文', updatedAt: 9, labelAt: 7, name: '新しい名前', group: '仕事', hidden: true });
  assert.deepEqual(mergeDocs(theirs, mine), mergeDocs(mine, theirs));
});

test('名前を消した変更も伝わり、削除されたメモはラベルで生き返らない', () => {
  const cleared = doc({ aaaa: { text: 'x', updatedAt: 1, labelAt: 8 } });
  const named = doc({ aaaa: { text: 'x', updatedAt: 1, labelAt: 5, name: '名前' } });
  assert.equal(mergeDocs(named, cleared).doc.memos.aaaa.name, undefined);
  const deleted = doc({ aaaa: { text: '', updatedAt: 6, deleted: true } });
  const renamed = doc({ aaaa: { text: 'x', updatedAt: 1, labelAt: 9, name: '後から' } });
  assert.equal(mergeDocs(renamed, deleted).doc.memos.aaaa.deleted, true);
});

test('壊れたラベルは捨て、長すぎる名前は切り詰める', () => {
  const clean = sanitizeDoc(doc({
    aaaa: { text: 'a', updatedAt: 1, labelAt: 2, name: 'あ'.repeat(100), group: '  仕事\n用 ', hidden: 'yes' },
    bbbb: { text: 'b', updatedAt: 1, labelAt: 'x', name: '時刻が無い' },
  }));
  assert.equal(clean.memos.aaaa.name.length, 40);
  assert.equal(clean.memos.aaaa.group, '仕事 用');
  assert.equal(clean.memos.aaaa.hidden, undefined);
  assert.deepEqual(clean.memos.bbbb, { text: 'b', updatedAt: 1 });
});

for (const mode of ['chrome', 'drive']) {
  test(`[${mode}] 名前・グループ・隠す印がほかの PC に届き、本文の編集で消えない`, async () => {
    const { a, b } = await pair(mode);
    const { ids } = await visible(a);
    await a.engine.edit(ids[0], 'パスワード: xxxx');
    await a.engine.label(ids[0], { name: 'サーバー', group: '仕事', hidden: true });
    await a.engine.sync();
    await b.engine.sync();
    const there = (await visible(b)).doc.memos[ids[0]];
    assert.deepEqual([there.name, there.group, there.hidden, there.text], ['サーバー', '仕事', true, 'パスワード: xxxx']);

    // B で本文を書き、同じころ A で名前を変えても、両方残る
    await b.engine.edit(ids[0], 'パスワード: yyyy');
    await a.engine.label(ids[0], { name: '本番サーバー' });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    for (const d of [a, b]) {
      const memo = (await visible(d)).doc.memos[ids[0]];
      assert.deepEqual([memo.name, memo.group, memo.hidden, memo.text], ['本番サーバー', '仕事', true, 'パスワード: yyyy']);
    }
  });
}

test('[chrome] ラベルだけを変えたときは、本文の断片を書き直さない', async () => {
  const { a } = await pair('chrome');
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], '本文');
  await a.engine.sync();
  const before = (await a.sync.get(`c:${ids[0]}:0`))[`c:${ids[0]}:0`];
  await a.engine.label(ids[0], { name: '名前' });
  const writes = [];
  const listener = (changes) => writes.push(...Object.keys(changes));
  a.sync.listeners.push(listener);
  await a.engine.sync();
  assert.deepEqual(writes, [`h:${ids[0]}`]);
  assert.deepEqual((await a.sync.get(`c:${ids[0]}:0`))[`c:${ids[0]}:0`], before);
});

test('グループに入れて作る・グループの名前を変える・グループを解く', async () => {
  const { a } = await pair('chrome');
  const { ids } = await visible(a);
  const added = await a.engine.add('仕事');
  await a.engine.label(ids[1], { group: '仕事' });
  await a.engine.label(ids[2], { group: '家' });
  let { doc: current } = await visible(a);
  assert.deepEqual(groupNames(current), ['仕事', '家']);
  assert.equal(current.memos[added].group, '仕事');

  assert.equal(await a.engine.renameGroup('仕事', 'しごと'), 2);
  ({ doc: current } = await visible(a));
  assert.deepEqual(groupNames(current), ['しごと', '家']);
  assert.equal(await a.engine.renameGroup('家', ''), 1);
  ({ doc: current } = await visible(a));
  assert.deepEqual(groupNames(current), ['しごと']);
  assert.equal(current.memos[ids[2]].group, undefined);
});

test('名前を付けた空のメモは、新しい PC の初期メモとして捨てられない', async () => {
  const { a, b } = await pair('chrome');
  const { ids } = await visible(a);
  await a.engine.label(ids[0], { name: 'あとで書く' });
  await a.engine.sync();
  await b.engine.sync();
  assert.equal((await visible(b)).doc.memos[ids[0]].name, 'あとで書く');
});

test('ゴミ箱とバックアップから戻すと、前の版で付けた名前とグループも戻る。隠したメモは一覧に本文も名前も出さない', async () => {
  const { a } = await pair('chrome');
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], '秘密の本文');
  await a.engine.label(ids[0], { name: '鍵', group: '家', hidden: true });
  const { trashId } = await a.engine.remove(ids[0]);
  const { trash } = await a.local.get('trash');
  assert.equal(trash[0].title, '隠しているメモ');
  assert.equal(trash[0].hidden, true);
  const { memoId } = await a.engine.restoreTrash(trashId);
  const restored = (await visible(a)).doc.memos[memoId];
  assert.deepEqual([restored.text, restored.name, restored.group, restored.hidden], ['秘密の本文', '鍵', '家', true]);

  const { backups } = await a.local.get('backups');
  await a.engine.label(memoId, { name: '', group: '', hidden: false });
  await a.engine.restore(backups.find((backup) => backup.memos.some((memo) => memo.text === '秘密の本文')).at);
  const back = Object.values((await visible(a)).doc.memos).find((memo) => memo.text === '秘密の本文' && !memo.deleted);
  assert.deepEqual([back.name, back.group, back.hidden], ['鍵', '家', true]);
});

test('隠しているメモは探さず、結果はメモの番号で返す', () => {
  const found = searchMemos(doc({
    aaaa: { text: 'token: abc', updatedAt: 1, labelAt: 1, hidden: true },
    bbbb: { text: 'token の説明', updatedAt: 1, labelAt: 1, name: 'メモ帳' },
  }), 'token');
  assert.deepEqual(found.results.map((r) => [r.id, r.number]), [['bbbb', 2]]);
});

test('[drive] 使用量：このアプリのファイルの合計と、ドライブ全体', async () => {
  const { a } = await pair('drive');
  const { ids } = await visible(a);
  await a.engine.addImage(ids[0], { type: 'image/png', data: 'iVBORw0KGgo=', width: 1, height: 1 });
  await a.engine.sync();
  const usage = await a.engine.driveUsage();
  assert.equal(usage.imageFiles, 1);
  assert.equal(usage.imageBytes, 8);
  assert.ok(usage.appBytes > usage.imageBytes);
  assert.equal(usage.driveLimit, 16106127360);
  assert.equal(usage.driveUsage, 5368709120);
});

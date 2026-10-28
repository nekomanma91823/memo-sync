// ゴミ箱・右クリックで送る・印を付けた画像の置き換え・画像付きの取り込み

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeSyncArea, createClock, createDevice, FakeDrive, visible, visibleTexts } from './fakes.mjs';
import { imageNumbers, memoImageIds, sanitizeDoc } from '../extension/lib/model.js';
import { readLocalDoc } from '../extension/lib/local-doc.js';
import { TRASH_TTL } from '../extension/lib/engine.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const image = () => ({ type: 'image/png', data: PNG, width: 1, height: 1 });

async function driveDevice(clock = createClock()) {
  const d = createDevice({ clock });
  await d.engine.ready();
  await d.local.set({ settings: { mode: 'drive' } });
  return d;
}

test('消したメモは画像ごとゴミ箱に入り、元の位置に戻せる', async () => {
  const d = await driveDevice();
  const { ids } = await visible(d);
  await d.engine.edit(ids[1], '消すメモ');
  await d.engine.addImage(ids[1], image());
  const { trashId } = await d.engine.remove(ids[1]);
  const { trash } = await d.local.get('trash');
  assert.deepEqual(trash.map(({ kind, title, chars, images }) => ({ kind, title, chars, images })), [{ kind: 'memo', title: '消すメモ', chars: 4, images: 1 }]);
  const { memoId } = await d.engine.restoreTrash(trashId);
  const after = await visible(d);
  assert.deepEqual(after.ids, [ids[0], memoId, ids[2]]);
  assert.equal(after.doc.memos[memoId].text, '消すメモ');
  const [restored] = memoImageIds(after.doc, memoId);
  assert.deepEqual((await d.local.get(`img:${restored}`))[`img:${restored}`], { type: 'image/png', data: PNG });
  assert.deepEqual((await d.local.get('trash')).trash, []);
  assert.equal((await d.local.get(`trash:${trashId}`))[`trash:${trashId}`], undefined);
});

test('消した画像はゴミ箱に入り、元のメモに戻せる。空のメモはゴミ箱に入れない', async () => {
  const d = await driveDevice();
  const { ids } = await visible(d);
  const imageId = await d.engine.addImage(ids[0], image());
  const { trashId } = await d.engine.removeImage(imageId);
  await d.engine.restoreTrash(trashId);
  assert.equal(memoImageIds(await readLocalDoc(d.local), ids[0]).length, 1);
  const removed = await d.engine.remove(ids[2]);
  assert.equal(removed.trashId, null);
});

test('画像の番号は貼った順に付き、消しても使い回さない。置き換えやゴミ箱から戻しても同じ番号のまま', async () => {
  const d = await driveDevice();
  const { ids } = await visible(d);
  const numbersNow = async () => [...imageNumbers(await readLocalDoc(d.local), ids[0]).values()];
  const first = await d.engine.addImage(ids[0], image());
  const second = await d.engine.addImage(ids[0], image());
  const third = await d.engine.addImage(ids[0], image());
  assert.deepEqual(await numbersNow(), [1, 2, 3]);
  // 3 を消してから貼っても 3 にはならない（本文に残った [画像 3] が、別の画像を指さないように）
  const { trashId } = await d.engine.removeImage(third);
  await d.engine.addImage(ids[0], image());
  assert.deepEqual(await numbersNow(), [1, 2, 4]);
  // ゴミ箱から戻すと、元の 3 に戻る
  await d.engine.restoreTrash(trashId);
  assert.deepEqual((await numbersNow()).sort(), [1, 2, 3, 4]);
  // 印を付けて置き換えても、元に戻しても、番号はそのまま
  const { id: replaced, trashId: before } = await d.engine.replaceImage(second, image());
  assert.equal(imageNumbers(await readLocalDoc(d.local), ids[0]).get(replaced), 2);
  const { id: reverted } = await d.engine.revertImage(replaced, before);
  assert.equal(imageNumbers(await readLocalDoc(d.local), ids[0]).get(reverted), 2);
  // 取り込みで番号を渡すと、空いていればその番号になる
  const imported = await d.engine.addImage(ids[1], image(), { no: 7 });
  const taken = await d.engine.addImage(ids[0], image(), { no: 1 });
  const doc = await readLocalDoc(d.local);
  assert.equal(imageNumbers(doc, ids[1]).get(imported), 7);
  assert.equal(imageNumbers(doc, ids[0]).get(taken), 5);
  // 同期の読み込みでも番号は残り、消した画像の記録にも残る
  const clean = sanitizeDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(clean.images[first].no, 1);
  assert.equal(clean.images[third].no, 3);
  assert.equal(clean.images[third].deleted, true);
});

test('番号の無い古い画像には、使われていない番号を並び順に振る', () => {
  const rec = (addedAt, extra = {}) => ({ memoId: 'aaaa', addedAt, updatedAt: addedAt, type: 'image/png', width: 1, height: 1, bytes: 3, ...extra });
  const doc = { images: { a: rec(1), b: rec(2, { no: 1 }), c: rec(3), gone: { memoId: 'aaaa', updatedAt: 4, deleted: true, no: 2 } } };
  assert.deepEqual([...imageNumbers(doc, 'aaaa')], [['a', 3], ['b', 1], ['c', 4]]);
});

test('ゴミ箱は 30 日で片付き、1 件ずつでも全部でも消せる', async () => {
  const clock = createClock();
  const d = await driveDevice(clock);
  const { ids } = await visible(d);
  await d.engine.edit(ids[0], 'a');
  await d.engine.edit(ids[1], 'b');
  const first = await d.engine.remove(ids[0]);
  await d.engine.remove(ids[1]);
  assert.equal(await d.engine.deleteTrash(first.trashId), 1);
  assert.equal((await d.local.get('trash')).trash.length, 1);
  clock.advance(TRASH_TTL + 1);
  await d.engine.autoBackup();
  assert.deepEqual((await d.local.get('trash')).trash, []);
  assert.equal(await d.engine.deleteTrash(), 0);
});

test('[drive] 他の端末で消されたメモと画像も、この PC の中身ごとゴミ箱に入る', async () => {
  const clock = createClock();
  const sync = chromeSyncArea();
  const drive = new FakeDrive({ now: clock });
  const a = createDevice({ sync, drive, clock });
  const b = createDevice({ sync, drive, clock });
  for (const device of [a, b]) {
    await device.engine.ready();
    await device.local.set({ settings: { mode: 'drive' } });
  }
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], 'B で消されるメモ');
  const imageId = await a.engine.addImage(ids[1], image());
  await a.engine.edit(ids[1], '画像だけ消される');
  await a.engine.sync();
  await b.engine.sync();
  await b.engine.remove(ids[0]);
  await b.engine.removeImage(imageId);
  await b.engine.sync();
  await a.engine.sync();
  const { trash } = await a.local.get('trash');
  assert.deepEqual(trash.map((entry) => entry.kind).sort(), ['image', 'memo']);
  const imageEntry = trash.find((entry) => entry.kind === 'image');
  await a.engine.restoreTrash(imageEntry.id);
  assert.equal(memoImageIds(await readLocalDoc(a.local), ids[1]).length, 1);
});

test('右クリックで送った文字は、表示中のメモの最後に足される', async () => {
  const d = await driveDevice();
  const { ids } = await visible(d);
  await d.local.set({ ui: { currentId: ids[1] } });
  await d.engine.appendText('選んだ文字\n— ページ名 https://example.com/');
  await d.engine.appendText('もう 1 つ');
  assert.equal((await visibleTexts(d))[1], '選んだ文字\n— ページ名 https://example.com/\n\nもう 1 つ');
  await assert.rejects(d.engine.appendText('  '), /ありません/);
});

test('印を付けた画像は同じ位置で置き換わり、元の画像はゴミ箱に入る', async () => {
  const d = await driveDevice();
  const { ids } = await visible(d);
  const first = await d.engine.addImage(ids[0], image());
  const second = await d.engine.addImage(ids[0], image());
  const { id: replaced, trashId } = await d.engine.replaceImage(first, image());
  assert.deepEqual(memoImageIds(await readLocalDoc(d.local), ids[0]), [replaced, second]);
  assert.equal((await d.local.get(`img:${first}`))[`img:${first}`], undefined);
  assert.equal((await d.local.get('trash')).trash[0].kind, 'image');
  // 「元に戻す」で、同じ位置に元の画像が戻り、印を付けた方はゴミ箱に入る
  assert.equal((await d.local.get('trash')).trash[0].id, trashId);
  const { id: restored } = await d.engine.revertImage(replaced, trashId);
  assert.deepEqual(memoImageIds(await readLocalDoc(d.local), ids[0]), [restored, second]);
  const { trash } = await d.local.get('trash');
  assert.equal(trash.length, 1);
  assert.notEqual(trash[0].id, trashId);
  await assert.rejects(d.engine.revertImage(restored, trashId), /見つかりませんでした/);
});

test('取り込みは取り込んだ先のメモの ID を返し、画像だけのメモも飛ばさない', async () => {
  const d = await driveDevice();
  const { count, ids } = await d.engine.importItems([{ text: '一' }, { text: '', images: 2 }, { text: ' ' }], 'append');
  assert.equal(count, 2);
  assert.equal(ids[2], null);
  const after = await visible(d);
  assert.deepEqual(after.ids.slice(-2), ids.slice(0, 2));
  // 画像は後から 1 枚ずつ貼る
  await d.engine.addImage(ids[1], image());
  assert.equal(memoImageIds(await readLocalDoc(d.local), ids[1]).length, 1);
  await assert.rejects(d.engine.importItems([{ text: 'x', images: -1 }], 'append'), /不正/);
});

test('グループの色など、メモ以外の同期データが変わっても同期し直さない', async () => {
  const d = createDevice({ clock: createClock() });
  await d.engine.ready();
  let scheduled = 0;
  d.engine.scheduleSync = () => {
    scheduled++;
  };
  await d.engine.onRemoteChange({ groupColors: { newValue: { 仕事: 'red' } } });
  assert.equal(scheduled, 0);
  await d.engine.onRemoteChange({ meta: { newValue: { v: 1, o: [], ou: 5 } } });
  assert.equal(scheduled, 1);
});

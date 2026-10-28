// メモに貼る画像（Google ドライブ同期のときだけ）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeSyncArea, createClock, createDevice, FakeDrive, visible } from './fakes.mjs';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MEMO,
  TOMBSTONE_TTL,
  createInitialDoc,
  dropOldTombstones,
  memoImageIds,
  mergeDocs,
  sanitizeDoc,
  visibleIds,
} from '../extension/lib/model.js';
import { readLocalDoc } from '../extension/lib/local-doc.js';
import { base64ToBytes, bytesToBase64 } from '../extension/lib/base64.js';

// 1×1 の PNG（先頭の 0x89 など、文字にすると壊れやすいバイトを含む）
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const image = (data = PNG) => ({ type: 'image/png', data, width: 1, height: 1 });
const record = (memoId, updatedAt, extra = {}) => ({
  memoId,
  addedAt: updatedAt,
  updatedAt,
  type: 'image/png',
  width: 1,
  height: 1,
  bytes: 70,
  ...extra,
});

async function pair(mode = 'drive') {
  const clock = createClock();
  const sync = chromeSyncArea();
  const drive = new FakeDrive({ now: clock });
  const a = createDevice({ sync, drive, clock });
  const b = createDevice({ sync, drive, clock });
  for (const device of [a, b]) {
    await device.engine.ready();
    if (mode === 'drive') await device.local.set({ settings: { mode: 'drive' } });
  }
  // どちらも同じメモの並びにしておく
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  return { a, b, clock, sync, drive };
}

async function blobOf(device, id) {
  return (await device.local.get(`img:${id}`))[`img:${id}`];
}

// ---- 統合のルール ----

test('画像の記録も新しい方が残り、同じ時刻なら削除が勝つ（引数の順番によらない）', () => {
  const base = { order: ['aaaa'], orderUpdatedAt: 1, memos: { aaaa: { text: 'x', updatedAt: 1 } } };
  const local = { ...base, images: { img1: record('aaaa', 5), img2: record('aaaa', 3) } };
  const remote = { ...base, images: { img1: { memoId: 'aaaa', updatedAt: 5, deleted: true }, img3: record('aaaa', 4) } };
  const merged = mergeDocs(local, remote).doc;
  assert.deepEqual(merged, mergeDocs(remote, local).doc);
  assert.equal(merged.images.img1.deleted, true);
  assert.deepEqual(memoImageIds(merged, 'aaaa'), ['img2', 'img3']);
});

test('画像を貼った初期メモは、文字が空でも捨てない', () => {
  const fresh = createInitialDoc();
  const withImage = fresh.order[1];
  fresh.images = { img1: record(withImage, 10) };
  const remote = { order: ['aaaa'], orderUpdatedAt: 10, memos: { aaaa: { text: 'hello', updatedAt: 10 } }, images: {} };
  const { doc, dropped } = mergeDocs(fresh, remote);
  assert.deepEqual(visibleIds(doc), ['aaaa', withImage]);
  assert.equal(dropped.length, 2);
});

test('古い削除の印と、片付けたメモの画像の記録は片付ける', () => {
  const now = 10 * TOMBSTONE_TTL;
  const doc = {
    order: ['bbbb'],
    orderUpdatedAt: 1,
    memos: { aaaa: { text: '', updatedAt: now - TOMBSTONE_TTL - 1, deleted: true }, bbbb: { text: 'b', updatedAt: 1 } },
    images: {
      img1: record('aaaa', 1),
      img2: { memoId: 'bbbb', updatedAt: now - TOMBSTONE_TTL - 1, deleted: true },
      img3: { memoId: 'bbbb', updatedAt: now - 5, deleted: true },
      img4: record('bbbb', 2),
    },
  };
  assert.deepEqual(Object.keys(dropOldTombstones(doc, now).doc.images), ['img3', 'img4']);
});

test('壊れた画像の記録は取り込まない', () => {
  const raw = JSON.parse(
    JSON.stringify({
      order: [],
      memos: {},
      images: {
        good: record('aaaa', 1),
        svg1: record('aaaa', 1, { type: 'image/svg+xml' }),
        huge: record('aaaa', 1, { bytes: MAX_IMAGE_BYTES + 1 }),
        nome: record('Bad!', 1),
        bad1: record('aaaa', 1, { width: 0 }),
      },
    }),
  );
  raw.images.__proto__ = record('aaaa', 1);
  assert.deepEqual(Object.keys(sanitizeDoc(raw).images), ['good']);
});

test('base64 との変換でバイトが変わらない', () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

// ---- 端末内の操作 ----

test('Chrome 同期のときは画像を貼れない', async () => {
  const d = createDevice({ clock: createClock() });
  await d.engine.ready();
  const { ids } = await visible(d);
  await assert.rejects(d.engine.addImage(ids[0], image()), /ドライブ/);
  assert.deepEqual((await readLocalDoc(d.local)).images, {});
});

test('貼った画像は端末内に置かれ、消すと本体も消える', async () => {
  const d = createDevice({ clock: createClock() });
  await d.engine.ready();
  await d.local.set({ settings: { mode: 'drive' } });
  const { ids } = await visible(d);
  const id = await d.engine.addImage(ids[0], image());
  assert.deepEqual(await blobOf(d, id), { type: 'image/png', data: PNG });
  const doc = await readLocalDoc(d.local);
  assert.deepEqual(memoImageIds(doc, ids[0]), [id]);
  assert.equal(doc.images[id].bytes, base64ToBytes(PNG).length);
  assert.equal((await d.local.get('dirty')).dirty, true);

  await d.engine.removeImage(id);
  assert.equal(await blobOf(d, id), undefined);
  assert.equal((await readLocalDoc(d.local)).images[id].deleted, true);
});

test('メモを消すと、貼った画像も消える', async () => {
  const d = createDevice({ clock: createClock() });
  await d.engine.ready();
  await d.local.set({ settings: { mode: 'drive' } });
  const { ids } = await visible(d);
  const id = await d.engine.addImage(ids[1], image());
  await d.engine.remove(ids[1]);
  assert.equal(await blobOf(d, id), undefined);
  assert.equal((await readLocalDoc(d.local)).images[id].deleted, true);
});

test('形式違い・大きすぎる・枚数の上限を超える画像は断る', async () => {
  const d = createDevice({ clock: createClock() });
  await d.engine.ready();
  await d.local.set({ settings: { mode: 'drive' } });
  const { ids } = await visible(d);
  await assert.rejects(d.engine.addImage(ids[0], { ...image(), type: 'image/svg+xml' }), /読み取れません/);
  await assert.rejects(d.engine.addImage(ids[0], { ...image(), data: 'not base64!' }), /読み取れません/);
  const big = bytesToBase64(new Uint8Array(MAX_IMAGE_BYTES + 3));
  await assert.rejects(d.engine.addImage(ids[0], image(big)), /大きすぎます/);
  for (let i = 0; i < MAX_IMAGES_PER_MEMO; i++) await d.engine.addImage(ids[0], image());
  await assert.rejects(d.engine.addImage(ids[0], image()), /枚まで/);
  await d.engine.addImage(ids[1], image());
});

// ---- ドライブでの同期 ----

test('[drive] 貼った画像が他の端末に届き、本体もそのまま届く', async () => {
  const { a, b, drive } = await pair();
  const { ids } = await visible(a);
  const id = await a.engine.addImage(ids[0], image());
  assert.equal((await a.engine.sync()).state, 'ok');

  // 本体は記録より先に送られている
  const [blobFile] = drive.filesNamed(`img-${id}`);
  const [jsonFile] = drive.filesNamed('memo-sync.json');
  assert.deepEqual(blobFile.content, base64ToBytes(PNG));
  assert.equal(blobFile.mimeType, 'image/png');
  assert.match(jsonFile.content, new RegExp(id));
  assert.ok(drive.requests.lastIndexOf('POST /upload/drive/v3/files') < drive.requests.lastIndexOf(`PATCH /upload/drive/v3/files/${jsonFile.id}`));

  assert.equal((await b.engine.sync()).state, 'ok');
  assert.deepEqual(memoImageIds(await readLocalDoc(b.local), ids[0]), [id]);
  assert.deepEqual(await blobOf(b, id), { type: 'image/png', data: PNG });
});

test('[drive] 消した画像は他の端末からも、ドライブからも消える', async () => {
  const { a, b, drive } = await pair();
  const { ids } = await visible(a);
  const id = await a.engine.addImage(ids[0], image());
  await a.engine.sync();
  await b.engine.sync();
  await b.engine.removeImage(id);
  await b.engine.sync();
  assert.equal(drive.filesNamed(`img-${id}`).length, 0);
  await a.engine.sync();
  assert.equal(await blobOf(a, id), undefined);
  assert.deepEqual(memoImageIds(await readLocalDoc(a.local), ids[0]), []);
});

test('[drive] 画像が多いときは数枚ずつ取り、続けて全部取る', async () => {
  const { a, b } = await pair();
  const { ids } = await visible(a);
  const added = [];
  for (let i = 0; i < 11; i++) added.push(await a.engine.addImage(ids[0], image()));
  await a.engine.sync();
  assert.equal((await b.engine.sync()).state, 'ok');
  for (const id of added) assert.ok(await blobOf(b, id), id);
});

test('[drive] 本体がまだ無い画像は、送った端末が次の同期で送り直す', async () => {
  const { a, b, drive } = await pair();
  const { ids } = await visible(a);
  const id = await a.engine.addImage(ids[0], image());
  await a.engine.sync();
  // 本体だけが失われた状態
  drive.files.delete(drive.filesNamed(`img-${id}`)[0].id);
  assert.equal((await b.engine.sync()).state, 'ok');
  assert.equal(await blobOf(b, id), undefined);
  await a.engine.sync();
  await b.engine.sync();
  assert.deepEqual(await blobOf(b, id), { type: 'image/png', data: PNG });
});

test('[drive] 記録の無い本体は、送っている途中かもしれないので 1 時間は消さない', async () => {
  const { a, drive, clock } = await pair();
  drive.addFile(base64ToBytes(PNG), { name: 'img-orphan1', mimeType: 'image/png', createdAt: clock() });
  await a.engine.sync();
  assert.equal(drive.filesNamed('img-orphan1').length, 1);
  clock.advance(61 * 60 * 1000);
  await a.engine.sync();
  assert.equal(drive.filesNamed('img-orphan1').length, 0);
});

test('[drive] 他の端末が先に消した本体を消そうとしても、同期は止まらない', async () => {
  const { a, drive } = await pair();
  const { ids } = await visible(a);
  const id = await a.engine.addImage(ids[0], image());
  await a.engine.sync();
  await a.engine.removeImage(id);
  const pull = a.engine.backends.drive.pull;
  a.engine.backends.drive.pull = async () => {
    const remote = await pull();
    drive.files.delete(drive.filesNamed(`img-${id}`)[0].id);
    return remote;
  };
  assert.equal((await a.engine.sync()).state, 'ok');
});

test('ドライブから Chrome 同期に切り替えても、画像はこの PC に残り、Chrome 同期には送らない', async () => {
  const { a, sync } = await pair();
  const { ids } = await visible(a);
  const id = await a.engine.addImage(ids[0], image());
  await a.engine.sync();
  assert.equal((await a.engine.setMode('chrome')).state, 'ok');
  assert.deepEqual(memoImageIds(await readLocalDoc(a.local), ids[0]), [id]);
  assert.ok(await blobOf(a, id));
  assert.doesNotMatch(JSON.stringify([...sync.data.entries()]), new RegExp(id));
});

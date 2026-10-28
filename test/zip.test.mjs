// 画像込みの書き出し・取り込み（ZIP）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeArea } from './fakes.mjs';
import { createZip, listZip } from '../extension/lib/zip.js';
import { exportFiles, parseBackupZip } from '../extension/lib/backup-format.js';
import { base64ToBytes } from '../extension/lib/base64.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// macOS の zip コマンドで圧縮したもの（フォルダが 1 段あり、中身は deflate）
const FIXTURE = 'UEsDBAoAAAAAALx7V10AAAAAAAAAAAAAAAALABwAbWVtb3N5bmNfeC9VVAkAA+T+2mrl/tpqdXgLAAEE9QEAAAQAAAAAUEsDBAoAAAAAALx7V10AAAAAAAAAAAAAAAASABwAbWVtb3N5bmNfeC9pbWFnZXMvVVQJAAPk/tpq5f7aanV4CwABBPUBAAAEAAAAAFBLAwQKAAAAAAC9e1ddAAAAAAAAAAAAAAAAGQAcAG1lbW9zeW5jX3gvaW1hZ2VzL21lbW8tMi9VVAkAA+X+2mrl/tpqdXgLAAEE9QEAAAQAAAAAUEsDBBQAAAAIAL17V12vyNBXPQAAAEQAAAAkABwAbWVtb3N5bmNfeC9pbWFnZXMvbWVtby0yL2ltYWdlLTEucG5nVVQJAAPl/tpq5f7aanV4CwABBPUBAAAEAAAAAOsM8HPn5ZLiYmBg4PX0cAkC0owgzMECJLfK8DABKW5PF8eQilvJKQlADhsDk0HjBX0gi8HT1c9lnVNCEwBQSwMEFAAAAAgAvHtXXX+pqvaIAAAA2AAAABQAHABtZW1vc3luY194L21lbW9zLnR4dFVUCQAD5P7aauX+2mp1eAsAAQT1AQAABAAAAADLTc3NL67MS9ZNrSjILypRMOTisgUBhcfNCx83L1IwVABzuZ7saHjcuOT57HWPG9dBpB43ND2d0PO4ccazae2PmyY937nhcVPXi/1THjdOf9y47Omc5c93ABX3PO3a+bix/3FTx+PGtseNqx83znzc1E2hXlQnGkGd+HzK7qfN/UBXPm7s5QIAUEsBAh4DCgAAAAAAvHtXXQAAAAAAAAAAAAAAAAsAGAAAAAAAAAAQAO1BAAAAAG1lbW9zeW5jX3gvVVQFAAPk/tpqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAAvHtXXQAAAAAAAAAAAAAAABIAGAAAAAAAAAAQAO1BRQAAAG1lbW9zeW5jX3gvaW1hZ2VzL1VUBQAD5P7aanV4CwABBPUBAAAEAAAAAFBLAQIeAwoAAAAAAL17V10AAAAAAAAAAAAAAAAZABgAAAAAAAAAEADtQZEAAABtZW1vc3luY194L2ltYWdlcy9tZW1vLTIvVVQFAAPl/tpqdXgLAAEE9QEAAAQAAAAAUEsBAh4DFAAAAAgAvXtXXa/I0Fc9AAAARAAAACQAGAAAAAAAAAAAAKSB5AAAAG1lbW9zeW5jX3gvaW1hZ2VzL21lbW8tMi9pbWFnZS0xLnBuZ1VUBQAD5f7aanV4CwABBPUBAAAEAAAAAFBLAQIeAxQAAAAIALx7V11/qar2iAAAANgAAAAUABgAAAAAAAEAAACkgX8BAABtZW1vc3luY194L21lbW9zLnR4dFVUBQAD5P7aanV4CwABBPUBAAAEAAAAAFBLBQYAAAAABQAFAMwBAABVAgAAAAA=';

const text = (bytes) => new TextDecoder().decode(bytes);
const encode = (s) => new TextEncoder().encode(s);

test('書いた ZIP をそのまま読める（日本語の名前・バイト列）', async () => {
  const files = [
    { name: 'memos.txt', data: encode('memosync-export 1\n\n===== メモ 1 =====\nこんにちは\n') },
    { name: 'images/memo-1/image-1.png', data: base64ToBytes(PNG) },
    { name: '日本語/名前.txt', data: encode('中身') },
  ];
  const entries = listZip(createZip(files));
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
  for (const [i, entry] of entries.entries()) assert.deepEqual(await entry.read(), files[i].data);
});

test('ほかの道具で圧縮し直した ZIP も、メモと画像を取り込める', async () => {
  const items = await parseBackupZip(listZip(base64ToBytes(FIXTURE)));
  assert.deepEqual(items.map((item) => [item.number, item.text.slice(0, 5), item.images.length]), [[1, '一つ目のメ', 0], [2, '画像つき', 1]]);
  const [picture] = items[1].images;
  assert.equal(picture.type, 'image/png');
  assert.deepEqual(await picture.read(), base64ToBytes(PNG));
});

test('__MACOSX は無視し、memos.txt が無い ZIP や壊れた ZIP は断る', async () => {
  const withJunk = createZip([
    { name: '__MACOSX/memos.txt', data: encode('x') },
    { name: 'a/memos.txt', data: encode('memosync-export 1\n\n===== メモ 1 =====\n本物\n') },
    { name: 'a/images/memo-1/image-2.webp', data: encode('2') },
    { name: 'a/images/memo-1/image-1.webp', data: encode('1') },
  ]);
  const [item] = await parseBackupZip(listZip(withJunk));
  assert.equal(item.text, '本物');
  assert.deepEqual(await Promise.all(item.images.map(async (image) => text(await image.read()))), ['1', '2']);
  await assert.rejects(parseBackupZip(listZip(createZip([{ name: 'x.txt', data: encode('') }]))), /memos\.txt/);
  assert.throws(() => listZip(encode('ZIP ではない')), /読めませんでした/);
});

test('中身が書かれた大きさより大きく広がる ZIP は止める', async () => {
  const bytes = base64ToBytes(FIXTURE);
  const view = new DataView(bytes.buffer);
  // memos.txt の中央レコードの「元の大きさ」を小さく書き換える
  for (let i = 0; i < bytes.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const name = text(bytes.subarray(i + 46, i + 46 + view.getUint16(i + 28, true)));
    if (name.endsWith('memos.txt')) view.setUint32(i + 24, 10, true);
  }
  const entry = listZip(bytes).find((e) => e.name.endsWith('memos.txt'));
  await assert.rejects(entry.read(), /壊れています/);
});

test('書き出す ZIP には、メモの番号ごとのフォルダに画像が入る', () => {
  const doc = {
    order: ['aaaa', 'bbbb'],
    orderUpdatedAt: 1,
    memos: { aaaa: { text: '一', updatedAt: 1 }, bbbb: { text: '二', updatedAt: 1 } },
    images: {
      img1: { memoId: 'bbbb', addedAt: 2, updatedAt: 2, type: 'image/webp', width: 1, height: 1, bytes: 3 },
      img2: { memoId: 'bbbb', addedAt: 1, updatedAt: 1, type: 'image/png', width: 1, height: 1, bytes: 3 },
      img3: { memoId: 'aaaa', addedAt: 1, updatedAt: 1, type: 'image/png', width: 1, height: 1, bytes: 3 },
    },
  };
  const blobs = { img1: { type: 'image/webp', data: PNG }, img2: { type: 'image/png', data: PNG } };
  const { files, images, missing } = exportFiles(doc, blobs);
  assert.deepEqual(files.map((f) => f.name), ['memos.txt', 'images/memo-2/image-1.png', 'images/memo-2/image-2.webp']);
  assert.equal(images, 2);
  assert.equal(missing, 1);
});

test('ZIP の画像のファイル名は画像の番号にし、取り込むときに番号を引き継ぐ', async () => {
  const doc = {
    order: ['aaaa'],
    orderUpdatedAt: 1,
    memos: { aaaa: { text: '[画像 3]', updatedAt: 1 } },
    images: { img3: { memoId: 'aaaa', addedAt: 1, updatedAt: 1, type: 'image/png', width: 1, height: 1, bytes: 3, no: 3 } },
  };
  const { files } = exportFiles(doc, { img3: { type: 'image/png', data: PNG } });
  assert.deepEqual(files.map((f) => f.name), ['memos.txt', 'images/memo-1/image-3.png']);
  const [item] = await parseBackupZip(listZip(createZip(files)));
  assert.deepEqual(item.images.map((image) => image.no), [3]);
});

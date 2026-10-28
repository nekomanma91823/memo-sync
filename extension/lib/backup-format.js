// メモのテキスト書き出しと取り込み。取り込みでメモごとに分けて読むのは、このアプリの書き出しだけ。
//
// 書き出しの形式。1 行目は目印の MAGIC、その後にメモごとに見出しの行と本文を並べる:
//   memosync-export 1\n\n===== メモ 1 =====\n本文\n===== メモ 2 =====\n本文\n
// 本文の中に、見出しと同じ形だけの行があると、そこで区切られる。
// この形式でないテキストは、ファイル全体を 1 件のメモとして取り込む。
//
// 画像があるときは ZIP にまとめる:
//   memos.txt                         上と同じ形式（文字だけ。単体でも取り込める）
//   images/memo-<番号>/image-<n>.<拡張子>  メモ <番号> に貼った画像。<n> は画像の番号で、本文の [画像 n] と対応する

import { IMAGE_EXTENSIONS, imageNumbers, memoImageIds, visibleIds } from './model.js';
import { base64ToBytes } from './base64.js';

const MAGIC = 'memosync-export 1';
const HEADER_RE = /^===== メモ (\d+) =====\n/gm;

export function exportText(doc) {
  const memos = visibleIds(doc).map((id, i) => `===== メモ ${i + 1} =====\n${doc.memos[id].text}\n`);
  return `${MAGIC}\n\n${memos.join('')}`;
}

// BOM を外し、Windows の改行をそろえる
const cleanText = (input) => String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

export function backupFileName(date = new Date(), extension = 'txt') {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `memosync_${stamp}.${extension}`;
}

const MEMOS_FILE = 'memos.txt';
const IMAGE_FILE_RE = /^images\/memo-(\d+)\/image-(\d+)\.(png|jpe?g|gif|webp)$/i;
const TYPE_OF = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_MEMOS_FILE_BYTES = 5 * 1024 * 1024;

// ZIP に入れるファイル。blobs は画像の ID → 端末内の本体 { type, data }
export function exportFiles(doc, blobs) {
  const files = [{ name: MEMOS_FILE, data: new TextEncoder().encode(exportText(doc)) }];
  let images = 0;
  let missing = 0;
  visibleIds(doc).forEach((memoId, i) => {
    // ファイル名は画像の番号にする（取り込んだあとも、本文の [画像 1] の印と合うように）
    const numbers = imageNumbers(doc, memoId);
    memoImageIds(doc, memoId).forEach((imageId) => {
      const blob = blobs[imageId];
      if (!blob) {
        missing++;
        return;
      }
      const name = `images/memo-${i + 1}/image-${numbers.get(imageId)}.${IMAGE_EXTENSIONS[blob.type] ?? 'img'}`;
      files.push({ name, data: base64ToBytes(blob.data) });
      images++;
    });
  });
  return { files, images, missing };
}

// listZip() の結果を [{ number, text, images: [{ type, size, read(), no }] }] にする。
// 展開してから圧縮し直した ZIP（フォルダが 1 段増える、__MACOSX が入る）も読めるようにする
export async function parseBackupZip(entries) {
  const usable = entries.filter((entry) => !entry.name.startsWith('__MACOSX/'));
  const memosEntry = usable.find((entry) => entry.name === MEMOS_FILE || entry.name.endsWith(`/${MEMOS_FILE}`));
  if (!memosEntry) throw new Error('memos.txt が入っていません。このアプリで書き出した ZIP を選んでください。');
  if (memosEntry.size > MAX_MEMOS_FILE_BYTES) throw new Error('memos.txt が大きすぎます');
  const base = memosEntry.name.slice(0, -MEMOS_FILE.length);
  const items = parseBackupText(new TextDecoder().decode(await memosEntry.read())).map((item) => ({ ...item, images: [] }));
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const found = [];
  for (const entry of usable) {
    if (!entry.name.startsWith(base)) continue;
    const match = entry.name.slice(base.length).match(IMAGE_FILE_RE);
    const item = match && byNumber.get(Number(match[1]));
    const no = Number(match?.[2]);
    if (item) found.push({ item, order: no, image: { type: TYPE_OF[match[3].toLowerCase()], size: entry.size, read: entry.read, no } });
  }
  found.sort((a, b) => a.order - b.order).forEach(({ item, image }) => item.images.push(image));
  return items;
}

// このアプリで書き出したファイルの形（1 行目が MAGIC）か。違えば、ファイル全体を 1 件のメモとして取り込む
export function isExportText(input) {
  const text = cleanText(input);
  return text === MAGIC || text.startsWith(`${MAGIC}\n`);
}

// [{ number, text }] を番号順で返す。このアプリの形式でないテキストは 1 件のメモとして扱う
export function parseBackupText(input) {
  const text = cleanText(input);
  if (!isExportText(text)) return text.trim() ? [{ number: 1, text: text.replace(/\n+$/, '') }] : [];
  const headers = [...text.matchAll(HEADER_RE)];
  return headers
    .map((match, i) => {
      const start = match.index + match[0].length;
      const end = headers[i + 1]?.index ?? text.length;
      // 書き出しで本文の後ろに足した改行を 1 つだけ外す
      return { number: Number(match[1]), text: text.slice(start, end).replace(/\n$/, '') };
    })
    .sort((a, b) => a.number - b.number);
}

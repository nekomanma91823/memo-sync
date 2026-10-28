// 端末内（chrome.storage.local）での文書の置き方。
//
//   meta        { order, orderUpdatedAt, deleted: { [id]: updatedAt } }
//   memo:<id>   { text, updatedAt, labelAt?, name?, group?, hidden? }   生きているメモ1件ずつ
//   images      { [id]: 画像の記録 }   削除済みの印も含む（model.js の images と同じ）
//   img:<id>    { type, data }        画像の本体（base64）。生きている画像のうち、この PC にあるものだけ
//
// メモを1件ずつ別のキーに置くのは、入力のたびに全メモを書き直さないため。
// 生きているメモは必ず order に入っている（normalizeDoc がそうする）ので、
// order を見れば読むべきキーがわかる。画像の本体は大きいので、文書を読むときには読まない。

import { labelOf, memoEquals, sanitizeDoc } from './model.js';

export const MEMO_PREFIX = 'memo:';
export const IMAGE_PREFIX = 'img:';

export function memoKey(id) {
  return MEMO_PREFIX + id;
}

export function imageKey(id) {
  return IMAGE_PREFIX + id;
}

export function docFromParts(meta, values, images) {
  const memos = {};
  for (const [key, memo] of Object.entries(values ?? {})) {
    if (key.startsWith(MEMO_PREFIX)) memos[key.slice(MEMO_PREFIX.length)] = memo;
  }
  for (const [id, updatedAt] of Object.entries(meta?.deleted ?? {})) {
    if (!memos[id]) memos[id] = { text: '', updatedAt, deleted: true };
  }
  return sanitizeDoc({ order: meta?.order, orderUpdatedAt: meta?.orderUpdatedAt, memos, images });
}

export async function readLocalDoc(area) {
  const { meta, images } = await area.get(['meta', 'images']);
  const order = Array.isArray(meta?.order) ? meta.order : [];
  const values = order.length ? await area.get(order.map(memoKey)) : {};
  return docFromParts(meta, values, images);
}

function metaOf(doc) {
  const deleted = {};
  for (const id of Object.keys(doc.memos).sort()) {
    if (doc.memos[id].deleted) deleted[id] = doc.memos[id].updatedAt;
  }
  return { order: doc.order, orderUpdatedAt: doc.orderUpdatedAt, deleted };
}

function imagesOf(doc) {
  return Object.fromEntries(Object.keys(doc.images).sort().map((id) => [id, doc.images[id]]));
}

// prev から変わったキーだけを書く。extra は同じ書き込みに含めたい値（dirty など）
export async function writeLocalDoc(area, next, prev, extra = {}) {
  const set = { ...extra };
  const remove = [];
  const meta = metaOf(next);
  if (!prev || JSON.stringify(meta) !== JSON.stringify(metaOf(prev))) set.meta = meta;
  const images = imagesOf(next);
  if (!prev || JSON.stringify(images) !== JSON.stringify(imagesOf(prev))) set.images = images;
  for (const [id, memo] of Object.entries(next.memos)) {
    if (memo.deleted) continue;
    const old = prev?.memos[id];
    if (!old || old.deleted || !memoEquals(old, memo)) {
      set[memoKey(id)] = { text: memo.text, updatedAt: memo.updatedAt, ...labelOf(memo) };
    }
  }
  for (const [id, old] of Object.entries(prev?.memos ?? {})) {
    const memo = next.memos[id];
    if (!old.deleted && (!memo || memo.deleted)) remove.push(memoKey(id));
  }
  // 消えた画像の本体も消す
  for (const [id, old] of Object.entries(prev?.images ?? {})) {
    const image = next.images[id];
    if (!old.deleted && (!image || image.deleted)) remove.push(imageKey(id));
  }
  if (Object.keys(set).length) await area.set(set);
  if (remove.length) await area.remove(remove);
}

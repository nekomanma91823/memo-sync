// 設定画面で、操作の前に「やるとどうなるか」を見積もる（chrome の API に頼らない部分）。
//   - Chrome の同期機能に切り替えたら、同期の領域をどれだけ使うか
//   - バックアップに戻したら、何件のメモが変わり、何件がゴミ箱に移るか
//   - 重なったときのバックアップで、どのメモを先に見せるか

import { SYNC_QUOTA_BYTES, splitText } from './chrome-sync.js';
import { labelOf, memoImageIds, visibleIds } from './model.js';

const encoder = new TextEncoder();
const itemBytes = (key, value) => encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
const isMemoKey = (key) => key === 'meta' || key.startsWith('h:') || key.startsWith('c:');

// これを超えると切り替えさせない（同期の途中で容量があふれて止まるのを避ける。chrome-sync.js は 98% で止める）
export const CHROME_SYNC_SAFE_BYTES = Math.floor(SYNC_QUOTA_BYTES * 0.95);

// chrome-sync.js と同じ置き方（meta・h:<id>・c:<id>:<i>）で書いたときの大きさ
export function chromeSyncBytes(doc) {
  let total = itemBytes('meta', { v: 1, o: doc.order, ou: doc.orderUpdatedAt });
  for (const [id, memo] of Object.entries(doc.memos)) {
    if (memo.deleted) {
      total += itemBytes(`h:${id}`, { u: memo.updatedAt, d: 1 });
      continue;
    }
    const chunks = splitText(memo.text);
    const { labelAt, name, group, hidden } = labelOf(memo);
    const label = labelAt === undefined ? {} : { l: labelAt, ...(name && { t: name }), ...(group && { g: group }), ...(hidden && { x: 1 }) };
    total += itemBytes(`h:${id}`, { u: memo.updatedAt, n: chunks.length, ...label });
    chunks.forEach((s, i) => {
      total += itemBytes(`c:${id}:${i}`, { u: memo.updatedAt, s });
    });
  }
  return total;
}

// 同期の領域にある、メモ以外のもの（グループの色など）の大きさ。all は chrome.storage.sync.get(null) の結果
export function otherSyncBytes(all) {
  return Object.entries(all ?? {})
    .filter(([key]) => !isMemoKey(key))
    .reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);
}

// 消していない画像の数
export function liveImageCount(doc) {
  return Object.values(doc.images ?? {}).filter((image) => !image.deleted && doc.memos[image.memoId] && !doc.memos[image.memoId].deleted).length;
}

// Chrome の同期機能に切り替えてよいか。bytes は見積もった大きさ
export function chromeSyncFit(bytes) {
  return {
    bytes,
    kb: Math.ceil(bytes / 1024),
    fits: bytes <= CHROME_SYNC_SAFE_BYTES,
    percent: Math.round((bytes / SYNC_QUOTA_BYTES) * 100),
  };
}

// バックアップに戻したときの見積もり。
//   memos: 戻したあとのメモの数、changed: 中身が今と変わる（または消したものが戻る）メモの数、
//   removed: バックアップの後に作られて、ゴミ箱に移るメモの数、removedImages: そこに貼ってある画像の数
export function restoreSummary(backup, doc) {
  const visible = visibleIds(doc);
  const ids = [];
  for (const memo of backup.memos ?? []) {
    if (typeof memo?.text !== 'string' || ids.includes(memo.id)) continue;
    ids.push(memo.id);
  }
  const textOf = new Map((backup.memos ?? []).map((memo) => [memo.id, memo.text]));
  const changed = ids.filter((id) => !visible.includes(id) || doc.memos[id].text !== textOf.get(id)).length;
  const removedIds = visible.filter((id) => !ids.includes(id));
  const removedImages = removedIds.reduce((sum, id) => sum + memoImageIds(doc, id).length, 0);
  return { memos: ids.length, changed, removed: removedIds.length, removedImages };
}

// バックアップの中のメモを、見せる順に並べる。重なったときのバックアップでは、重なったメモを先に。
// 返り値: [{ memo, number（バックアップの中での番号）, conflicted }]
export function backupMemoRows(backup) {
  const conflicts = Array.isArray(backup.conflicts) ? backup.conflicts : [];
  const rows = (backup.memos ?? []).map((memo, i) => ({ memo, number: i + 1, conflicted: conflicts.includes(memo.id) }));
  return [...rows.filter((row) => row.conflicted), ...rows.filter((row) => !row.conflicted)];
}

// 同期方式①：Chrome の同期機能（chrome.storage.sync）
//
// 同期領域の置き方:
//   meta          { v: 1, o: 並び順, ou: 並び順の更新時刻 }
//   h:<id>        { u: 更新時刻, n: 断片の数, l?, t?, g?, x? } または削除済みなら { u, d: 1 }
//                 l・t・g・x はラベル（labelAt・名前・グループ・隠す印）。ラベルだけ変えたときは見出しだけ書く
//   c:<id>:<i>    { u: 更新時刻, s: 本文の断片 }
//
// chrome.storage.sync は 1 項目 8KB までなので、本文は約 7KB ずつに分けて置く。
// 断片には見出し（h:）と同じ更新時刻を入れておき、他の端末から一部しか届いていない
// 状態（時刻が揃わない）では取り込まず、上書きもしない。

import { labelOf, memoEquals, sanitizeDoc } from './model.js';
import { QuotaError, RemoteError } from './errors.js';

export const SYNC_QUOTA_BYTES = 102_400;
const SYNC_MAX_ITEMS = 512;
const CHUNK_BYTES = 7_000;
const MAX_CHUNKS = 200;

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;
const itemBytes = (key, value) => byteLength(key) + byteLength(JSON.stringify(value));

function headerLabel(memo) {
  const { labelAt, name, group, hidden } = labelOf(memo);
  if (labelAt === undefined) return {};
  const out = { l: labelAt };
  if (name) out.t = name;
  if (group) out.g = group;
  if (hidden) out.x = 1;
  return out;
}

// JSON にしたときの大きさが limit バイト以下になるように本文を分ける
export function splitText(text, limit = CHUNK_BYTES) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let lo = start + 1;
    let hi = Math.min(text.length, start + limit);
    let end = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (byteLength(JSON.stringify(text.slice(start, mid))) <= limit) {
        end = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // 絵文字など 2 つで 1 文字になる文字（サロゲートペア）を途中で切らない
    const code = text.charCodeAt(end - 1);
    if (end < text.length && end - 1 > start && code >= 0xd800 && code <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function toRemoteError(error) {
  const message = String(error?.message ?? error);
  if (/QUOTA_BYTES|MAX_ITEMS/.test(message)) {
    return new QuotaError('Chrome 同期の容量 100KB を超えたため、ほかの PC に送れません。メモを短くするか、Google ドライブ同期に切り替えてください。');
  }
  if (/MAX_WRITE_OPERATIONS/.test(message)) {
    return new RemoteError('Chrome 同期の書き込み回数の上限に達しました。しばらくすると自動で再開します。');
  }
  return new RemoteError(`Chrome 同期に失敗しました。${message}`);
}

export function createChromeSyncBackend(area) {
  // 直前に自分で書いた内容。onChanged が自分の書き込みかどうかを見分けるのに使う
  let ownWrites = new Map();

  return {
    async pull() {
      let all;
      try {
        all = await area.get(null);
      } catch (error) {
        throw toRemoteError(error);
      }
      const headers = {};
      const chunkKeys = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith('h:')) headers[key.slice(2)] = value;
        else if (key.startsWith('c:')) (chunkKeys[key.split(':')[1]] ??= []).push(key);
      }

      const memos = {};
      const pending = new Set();
      for (const [id, header] of Object.entries(headers)) {
        if (!header || !Number.isFinite(header.u)) continue;
        if (header.d) {
          memos[id] = { text: '', updatedAt: header.u, deleted: true };
          continue;
        }
        const count = Number.isInteger(header.n) && header.n >= 0 && header.n <= MAX_CHUNKS ? header.n : -1;
        const parts = [];
        for (let i = 0; i < count; i++) {
          const chunk = all[`c:${id}:${i}`];
          if (!chunk || chunk.u !== header.u || typeof chunk.s !== 'string') break;
          parts.push(chunk.s);
        }
        if (parts.length === count) {
          memos[id] = { text: parts.join(''), updatedAt: header.u, labelAt: header.l, name: header.t, group: header.g, hidden: header.x === 1 };
        }
        else pending.add(id);
      }

      const meta = all.meta && typeof all.meta === 'object' ? all.meta : null;
      const hasData = meta || Object.keys(headers).length > 0;
      const doc = hasData ? sanitizeDoc({ order: meta?.o, orderUpdatedAt: meta?.ou, memos }) : null;
      return { doc, meta, headers, chunkKeys, pending, all };
    },

    async push(doc, remote, dropped = []) {
      const set = {};
      const remove = new Set();
      const remoteMemos = remote.doc?.memos ?? {};

      for (const [id, memo] of Object.entries(doc.memos)) {
        if (remote.pending.has(id)) continue;
        const current = remoteMemos[id];
        if (current && memoEquals(current, memo)) continue;
        // ラベルだけが変わったときは、本文の断片は書き直さない
        const header = remote.headers[id];
        if (current && !current.deleted && !memo.deleted && current.text === memo.text && current.updatedAt === memo.updatedAt) {
          set[`h:${id}`] = { u: memo.updatedAt, n: header.n, ...headerLabel(memo) };
          continue;
        }
        const chunks = memo.deleted ? [] : splitText(memo.text);
        set[`h:${id}`] = memo.deleted ? { u: memo.updatedAt, d: 1 } : { u: memo.updatedAt, n: chunks.length, ...headerLabel(memo) };
        chunks.forEach((s, i) => {
          set[`c:${id}:${i}`] = { u: memo.updatedAt, s };
        });
        for (const key of remote.chunkKeys[id] ?? []) if (!(key in set)) remove.add(key);
      }

      // 捨てた初期メモ・片付けた削除済みの印・見出しの無い断片を同期領域から消す
      const gone = new Set(dropped);
      for (const id of Object.keys(remote.headers)) {
        if (!doc.memos[id] && !remote.pending.has(id)) gone.add(id);
      }
      for (const id of Object.keys(remote.chunkKeys)) {
        if (!remote.headers[id] && !doc.memos[id]) gone.add(id);
      }
      for (const id of gone) {
        if (remote.headers[id]) remove.add(`h:${id}`);
        for (const key of remote.chunkKeys[id] ?? []) remove.add(key);
      }

      const meta = { v: 1, o: doc.order, ou: doc.orderUpdatedAt };
      if (!remote.meta || remote.meta.ou !== meta.ou || JSON.stringify(remote.meta.o) !== JSON.stringify(meta.o)) {
        set.meta = meta;
      }

      if (!Object.keys(set).length && !remove.size) return;

      // 書き込む前に容量を見積もり、途中まで書いて止まる状態を避ける
      let total = 0;
      let items = 0;
      for (const [key, value] of Object.entries(remote.all)) {
        if (remove.has(key) || key in set) continue;
        total += itemBytes(key, value);
        items++;
      }
      for (const [key, value] of Object.entries(set)) {
        total += itemBytes(key, value);
        items++;
      }
      if (total > SYNC_QUOTA_BYTES * 0.98 || items > SYNC_MAX_ITEMS - 8) {
        throw new QuotaError('Chrome 同期の容量 100KB を超えるため、ほかの PC に送れません。メモを短くするか、Google ドライブ同期に切り替えてください。');
      }

      ownWrites = new Map();
      for (const [key, value] of Object.entries(set)) ownWrites.set(key, JSON.stringify(value));
      for (const key of remove) ownWrites.set(key, undefined);
      try {
        if (Object.keys(set).length) await area.set(set);
        if (remove.size) await area.remove([...remove]);
      } catch (error) {
        throw toRemoteError(error);
      }
    },

    // chrome.storage.onChanged の変更が、すべて直前の自分の書き込みなら true
    isOwnChange(changes) {
      return Object.entries(changes).every(([key, change]) => {
        if (!ownWrites.has(key)) return false;
        const value = change.newValue === undefined ? undefined : JSON.stringify(change.newValue);
        return ownWrites.get(key) === value;
      });
    },
  };
}

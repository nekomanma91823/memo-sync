// メモのデータ構造と、端末どうしの内容を統合する処理。
// chrome の API を使わないので、Node のテストからもそのまま読み込める。
//
// 文書（doc）の形:
//   order          画面に並べるメモ ID の順番
//   orderUpdatedAt 並び順を最後に変えた時刻（ミリ秒）
//   memos          { [id]: { text, updatedAt, deleted?, labelAt?, name?, group?, hidden? } }
//                  name はタブに出す名前、group はグループの名前、hidden は画面で隠すメモの印。
//                  この 3 つ（ラベル）は本文とは別に、labelAt を時刻として統合する
//   images         { [id]: { memoId, addedAt, updatedAt, type, width, height, bytes, no? } }
//                  メモに貼った画像の記録。削除済みは { memoId, updatedAt, deleted: true, no? }。
//                  no はメモの中での画像の番号で、本文の [画像 1] の印と対応する（imageNumbers）。
//                  削除しても番号は記録に残し、同じ番号を別の画像に使い回さない
//                  画像の本体は記録とは別に置く（端末内は local-doc.js、ドライブは drive-sync.js）
//
// 統合のルール:
//   - メモはそれぞれ updatedAt が新しい方を採用する（同時刻なら決まった規則で片方を選ぶ）
//   - 削除は deleted: true の印として残し、他の端末にも伝える
//   - 並び順は orderUpdatedAt が新しい方を採用し、そこに無い生きたメモは末尾に足す
//   - 一度も編集されていない初期メモ（updatedAt が 0）は、採用した並び順に無ければ捨てる。
//     新しい端末が最初に作る空のメモが、同期のたびに他の端末へ増えていかないようにするため。
//     画像が付いたメモは、文字が空でも捨てない
//   - 画像の記録もメモと同じく updatedAt が新しい方を採用する（貼った後に変わるのは削除だけ）
//   - ラベルは labelAt が新しい方を採用する。ある PC で名前を変え、別の PC で本文を書いても両方残る。
//     削除されたメモは、ラベルが後から変わっていても削除のまま

export const INITIAL_MEMOS = 3;
export const MIN_MEMOS = 1;
export const MAX_MEMOS = 100;
export const MAX_TEXT_LENGTH = 100_000;
export const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000;

// 画像。貼れるのは Google ドライブ同期のときだけ（Chrome 同期は全体で 100KB しか入らない）
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_PER_MEMO = 20;
export const MAX_IMAGES = 200;
const MAX_IMAGE_SIDE = 100_000;
const MAX_IMAGE_NO = 99_999;

export const MAX_NAME_LENGTH = 40;
export const MAX_GROUP_LENGTH = 30;

// 同期先から読んだデータで、これより長い本文は壊れたデータとして扱う
const MAX_STORED_TEXT = 1_000_000;
const ID_RE = /^[a-z0-9]{4,32}$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const isStamp = (n) => Number.isFinite(n) && n >= 0;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

export function emptyDoc() {
  return { order: [], orderUpdatedAt: 0, memos: {}, images: {} };
}

export function createInitialDoc(count = INITIAL_MEMOS) {
  const doc = emptyDoc();
  for (let i = 0; i < count; i++) {
    const id = newId();
    doc.order.push(id);
    doc.memos[id] = { text: '', updatedAt: 0 };
  }
  return doc;
}

export function isPristine(memo) {
  return memo.updatedAt === 0 && !memo.deleted && memo.text === '' && memo.labelAt === undefined;
}

// ---- ラベル（名前・グループ・隠す印） ----

// 改行や続いた空白を 1 つの空白にし、長すぎる分は切る
export function cleanLabel(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// メモのラベルの部分だけ。無い項目は入れない（labelAt が無ければ空）
export function labelOf(memo) {
  if (!memo || memo.deleted || !isStamp(memo.labelAt)) return {};
  const label = { labelAt: memo.labelAt };
  const name = cleanLabel(memo.name, MAX_NAME_LENGTH);
  const group = cleanLabel(memo.group, MAX_GROUP_LENGTH);
  if (name) label.name = name;
  if (group) label.group = group;
  if (memo.hidden === true) label.hidden = true;
  return label;
}

// 時刻を除いたラベル（バックアップやゴミ箱に残す形）
export function labelFields(memo) {
  const { labelAt, ...fields } = labelOf(memo);
  return fields;
}

export function sameLabel(a, b) {
  return (a.name ?? '') === (b.name ?? '') && (a.group ?? '') === (b.group ?? '') && !!a.hidden === !!b.hidden;
}

// ラベルを fields（{ name, group, hidden }）にしたメモを返す
export function setLabel(memo, fields, now) {
  const labelAt = Math.max(now, (memo.labelAt ?? 0) + 1);
  return { text: memo.text, updatedAt: memo.updatedAt, ...labelOf({ ...fields, labelAt }) };
}

// グループの名前を、メモの並びで最初に出てくる順に
export function groupNames(doc) {
  const names = [];
  for (const id of visibleIds(doc)) {
    const group = doc.memos[id].group;
    if (group && !names.includes(group)) names.push(group);
  }
  return names;
}

// お知らせやゴミ箱でメモを指す 1 行目。隠しているメモは本文を出さない
export function displayTitle(memo, max = 20) {
  return memo.hidden ? '隠しているメモ' : memoTitle(memo.text, max);
}

export function visibleIds(doc) {
  return doc.order.filter((id) => doc.memos[id] && !doc.memos[id].deleted);
}

// メモに貼った画像の ID を、貼った順に返す
export function memoImageIds(doc, memoId) {
  return Object.entries(doc.images ?? {})
    .filter(([, image]) => image.memoId === memoId && !image.deleted)
    .sort(([idA, a], [idB, b]) => a.addedAt - b.addedAt || (idA < idB ? -1 : 1))
    .map(([id]) => id);
}

// 画像が 1 枚でも付いているメモの ID
function memosWithImages(images) {
  return new Set(Object.values(images ?? {}).filter((image) => !image.deleted).map((image) => image.memoId));
}

// 画像を消したときの印
export function imageTombstone(image, now) {
  return { memoId: image.memoId, updatedAt: Math.max(now, image.updatedAt + 1), deleted: true, ...imageNoField(image.no) };
}

const isImageNo = (no) => Number.isInteger(no) && no > 0 && no <= MAX_IMAGE_NO;
const imageNoField = (no) => (isImageNo(no) ? { no } : {});

// メモに貼った画像の番号（画像の ID → 番号）。本文の [画像 1] と対応する。
// 番号の無い古い画像には、まだ使われていない番号を並び順に振る
export function imageNumbers(doc, memoId) {
  const records = Object.values(doc.images ?? {}).filter((image) => image.memoId === memoId);
  const used = new Set(records.map((image) => image.no).filter(isImageNo));
  const numbers = new Map();
  let next = 1;
  for (const id of memoImageIds(doc, memoId)) {
    let { no } = doc.images[id];
    if (!isImageNo(no)) {
      while (used.has(next)) next++;
      no = next;
      used.add(no);
    }
    numbers.set(id, no);
  }
  return numbers;
}

// 次に貼る画像の番号。削除した画像の番号も避ける（本文に残った印が、別の画像を指さないように）
export function nextImageNo(doc, memoId) {
  let max = 0;
  for (const image of Object.values(doc.images ?? {})) {
    if (image.memoId === memoId && isImageNo(image.no)) max = Math.max(max, image.no);
  }
  for (const no of imageNumbers(doc, memoId).values()) max = Math.max(max, no);
  return max + 1;
}

// メモを消すときは、そのメモに貼った画像も消す
export function removeImagesOf(images, memoIds, now) {
  const next = { ...images };
  for (const [id, image] of Object.entries(images)) {
    if (!image.deleted && memoIds.includes(image.memoId)) next[id] = imageTombstone(image, now);
  }
  return next;
}

export function memoEquals(a, b) {
  return (
    a.text === b.text &&
    a.updatedAt === b.updatedAt &&
    !!a.deleted === !!b.deleted &&
    JSON.stringify(labelOf(a)) === JSON.stringify(labelOf(b))
  );
}

const IMAGE_FIELDS = ['memoId', 'addedAt', 'updatedAt', 'type', 'width', 'height', 'bytes', 'deleted', 'no'];

export function imageEquals(a, b) {
  return IMAGE_FIELDS.every((field) => a[field] === b[field]);
}

export function docEquals(a, b) {
  if (a.orderUpdatedAt !== b.orderUpdatedAt || a.order.length !== b.order.length) return false;
  if (a.order.some((id, i) => id !== b.order[i])) return false;
  const ids = Object.keys(a.memos);
  if (ids.length !== Object.keys(b.memos).length) return false;
  if (!ids.every((id) => b.memos[id] && memoEquals(a.memos[id], b.memos[id]))) return false;
  const imageIds = Object.keys(a.images);
  if (imageIds.length !== Object.keys(b.images).length) return false;
  return imageIds.every((id) => b.images[id] && imageEquals(a.images[id], b.images[id]));
}

function newerMemo(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  return a.text >= b.text ? a : b;
}

function newerLabel(a, b) {
  const at = (label) => label.labelAt ?? -1;
  if (at(a) !== at(b)) return at(a) > at(b) ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

// 本文は updatedAt、ラベルは labelAt で、それぞれ新しい方を採用する
function mergeMemo(a, b) {
  const base = newerMemo(a, b);
  if (base.deleted) return { text: '', updatedAt: base.updatedAt, deleted: true };
  return { text: base.text, updatedAt: base.updatedAt, ...newerLabel(labelOf(a), labelOf(b)) };
}

function newerImage(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  const key = (image) => JSON.stringify(IMAGE_FIELDS.map((field) => image[field] ?? null));
  return key(a) >= key(b) ? a : b;
}

// 並び順の更新時刻が同じ（どちらも作ってから並べ替えていない）ときは、書かれたメモを
// 多く含む方を選ぶ。新しい端末で同期が届く前に少し書いても、既存の端末の並びが残る
function newerOrder(a, b, memos, images) {
  if (a.orderUpdatedAt !== b.orderUpdatedAt) return a.orderUpdatedAt > b.orderUpdatedAt ? a : b;
  const withImages = memosWithImages(images);
  const written = (order) =>
    order.filter((id) => memos[id] && !memos[id].deleted && (!isPristine(memos[id]) || withImages.has(id))).length;
  const wa = written(a.order);
  const wb = written(b.order);
  if (wa !== wb) return wa > wb ? a : b;
  return JSON.stringify(a.order) >= JSON.stringify(b.order) ? a : b;
}

// どちらの端末で計算しても同じ結果になる（引数の順番を入れ替えても結果は変わらない）
export function mergeDocs(local, remote) {
  if (!remote) return normalizeDoc(local);
  const memos = {};
  for (const id of new Set([...Object.keys(local.memos), ...Object.keys(remote.memos)])) {
    const l = local.memos[id];
    const r = remote.memos[id];
    memos[id] = l && r ? mergeMemo(l, r) : { ...(l ?? r) };
  }
  // Chrome 同期の相手には画像の記録が無いので、手元の記録がそのまま残る
  const images = {};
  const localImages = local.images ?? {};
  const remoteImages = remote.images ?? {};
  for (const id of new Set([...Object.keys(localImages), ...Object.keys(remoteImages)])) {
    const l = localImages[id];
    const r = remoteImages[id];
    images[id] = { ...(l && r ? newerImage(l, r) : (l ?? r)) };
  }
  const order = newerOrder(local, remote, memos, images);
  return normalizeDoc({ order: order.order, orderUpdatedAt: order.orderUpdatedAt, memos, images });
}

// 並び順の重複と削除済みを取り除き、並び順から漏れたメモを末尾に足す。
// dropped は捨てた初期メモの ID（同期先からも消すために返す）
export function normalizeDoc(doc) {
  const memos = { ...doc.memos };
  const images = { ...doc.images };
  const withImages = memosWithImages(images);
  const seen = new Set();
  const order = [];
  for (const id of doc.order) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!memos[id]?.deleted) order.push(id);
  }
  const dropped = [];
  const orphans = [];
  for (const [id, memo] of Object.entries(memos)) {
    if (seen.has(id) || memo.deleted) continue;
    if (isPristine(memo) && !withImages.has(id)) {
      delete memos[id];
      dropped.push(id);
    } else {
      orphans.push(id);
    }
  }
  orphans.sort();
  return {
    doc: { order: [...order, ...orphans], orderUpdatedAt: doc.orderUpdatedAt, memos, images },
    dropped,
  };
}

// 古い削除済みの印を片付ける。長く同期していなかった端末から、消したメモが戻ることはある。
// 片付けたメモに付いていた画像の記録も片付ける
export function dropOldTombstones(doc, now) {
  const memos = { ...doc.memos };
  const dropped = [];
  for (const [id, memo] of Object.entries(memos)) {
    if (memo.deleted && now - memo.updatedAt > TOMBSTONE_TTL) {
      delete memos[id];
      dropped.push(id);
    }
  }
  const images = { ...doc.images };
  for (const [id, image] of Object.entries(images)) {
    if ((image.deleted && now - image.updatedAt > TOMBSTONE_TTL) || !memos[image.memoId]) delete images[id];
  }
  return { doc: { ...doc, memos, images }, dropped };
}


function sanitizeImage(image) {
  if (!image || typeof image !== 'object' || !isValidId(image.memoId) || !isStamp(image.updatedAt)) return null;
  const { memoId, updatedAt } = image;
  if (image.deleted === true) return { memoId, updatedAt, deleted: true, ...imageNoField(image.no) };
  const { addedAt, type, width, height, bytes } = image;
  if (!isStamp(addedAt) || !IMAGE_TYPES.includes(type)) return null;
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= MAX_IMAGE_SIDE)) return null;
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_IMAGE_BYTES) return null;
  return { memoId, addedAt, updatedAt, type, width, height, bytes, ...imageNoField(image.no) };
}

// 端末内や同期先から読んだデータの形を確かめ、使えない部分は捨てる
export function sanitizeDoc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.memos && typeof raw.memos === 'object' ? raw.memos : {};
  const memos = {};
  for (const id of Object.keys(source)) {
    const memo = source[id];
    if (!isValidId(id) || !memo || typeof memo !== 'object') continue;
    const { updatedAt } = memo;
    if (!Number.isFinite(updatedAt) || updatedAt < 0) continue;
    if (memo.deleted === true) {
      memos[id] = { text: '', updatedAt, deleted: true };
    } else if (typeof memo.text === 'string' && memo.text.length <= MAX_STORED_TEXT) {
      memos[id] = { text: memo.text, updatedAt, ...labelOf(memo) };
    }
  }
  const order = Array.isArray(raw.order) ? raw.order.filter(isValidId).slice(0, MAX_MEMOS * 10) : [];
  const { orderUpdatedAt } = raw;
  const sourceImages = raw.images && typeof raw.images === 'object' ? raw.images : {};
  const images = {};
  for (const id of Object.keys(sourceImages).slice(0, MAX_IMAGES * 10)) {
    const image = isValidId(id) ? sanitizeImage(sourceImages[id]) : null;
    if (image) images[id] = image;
  }
  return {
    order,
    orderUpdatedAt: isStamp(orderUpdatedAt) ? orderUpdatedAt : 0,
    memos,
    images,
  };
}

// 前回の同期のあと両方の端末で書き換わっていて、統合で片方の内容が消えるメモを探す。
// synced は前回の同期で同期先と揃えたときの各メモの updatedAt。それと違えば、その後に書き換わっている。
//   - この PC でまだ送っていない編集が、他の端末の後からの編集に負けて消える
//   - 他の端末の、この PC がまだ見ていない編集が、この PC の後からの編集（や削除）に負けて消える
// 返り値の lost は、消える側の内容に置き換えた文書（バックアップ用）
export function findConflicts(before, remote, after, synced) {
  const lost = { ...before, order: [...before.order], memos: { ...before.memos } };
  const ids = [];
  for (const id of visibleIds(before)) {
    const mine = before.memos[id];
    if (!mine.text.trim() || mine.updatedAt === synced[id]) continue;
    const now = after.memos[id];
    if (!now || now.deleted || now.text !== mine.text) ids.push(id);
  }
  for (const [id, theirs] of Object.entries(remote?.memos ?? {})) {
    if (theirs.deleted || !theirs.text.trim() || theirs.updatedAt === synced[id] || ids.includes(id)) continue;
    const now = after.memos[id];
    if (now && !now.deleted && now.text === theirs.text) continue;
    lost.memos[id] = { ...theirs };
    if (!lost.order.includes(id)) lost.order.push(id);
    ids.push(id);
  }
  return { ids, lost };
}

// お知らせでメモを指すための短い名前（最初の行）
export function memoTitle(text, max = 20) {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// 同期で中身が消えたり大きく減ったりするか。そのときは先にバックアップを取る
export function losesContent(before, after) {
  for (const id of visibleIds(before)) {
    const old = before.memos[id];
    if (!old.text.trim()) continue;
    const now = after.memos[id];
    if (!now || now.deleted || !now.text.trim()) return true;
    if (now.text.length < old.text.length * 0.5) return true;
  }
  return false;
}

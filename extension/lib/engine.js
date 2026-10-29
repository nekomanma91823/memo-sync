// バックグラウンドで動く、保存と同期の中心。
//
// メモの保存はすべてここを通す（画面からはメッセージで頼む）。ポップアップの入力と
// 他の端末から届いた内容が同時に書き込まれて片方が消えないように、端末内の
// 読み書きは exclusive() で 1 つずつ順番に行う。同期先との通信はその外で行う。
//
// 画像は Google ドライブ同期のときだけ貼れる。本体はまず端末内に置き、同期のときに
// ドライブへ送る。他の端末で貼られた画像の本体は、同期のときに数枚ずつ取ってくる。
//
// 同じメモを 2 台で同期の前に編集すると、後から編集した方が残る。そのとき負けた側の内容が
// 黙って消えないよう、同期した端末でバックアップに取り、画面にお知らせを出す
// （どのメモが書き換わったかは、前回の同期で揃えた updatedAt を synced に覚えておいて見分ける）。
//
// 消したメモと画像は、画像の本体ごと端末内のゴミ箱に 30 日間残す。他の端末で消されて
// 同期で消えたものも、この PC に中身があればゴミ箱に入れる。
//   trash        [{ id, at, kind: 'memo' | 'image', title, chars, images }]  新しい順
//   trash:<id>   { kind, text?, label?, memoId?, position?, images: [{ type, width, height, data, no }] }
//
// メモの名前・グループ・隠す印（ラベル）は本文とは別の時刻（labelAt）で持つ。本文の編集では変えない。

import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_IMAGES_PER_MEMO,
  MAX_GROUP_LENGTH,
  MAX_MEMOS,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MIN_MEMOS,
  cleanLabel,
  createInitialDoc,
  displayTitle,
  dropOldTombstones,
  imageNumbers,
  imageTombstone,
  isValidId,
  labelFields,
  labelOf,
  losesContent,
  memoImageIds,
  mergeDocs,
  newId,
  nextImageNo,
  findConflicts,
  normalizeDoc,
  removeImagesOf,
  sameLabel,
  setLabel,
  visibleIds,
} from './model.js';
import { imageKey, memoKey, readLocalDoc, writeLocalDoc } from './local-doc.js';
import { base64ByteLength, isBase64 } from './base64.js';
import { AuthError, LimitError, QuotaError, RemoteError } from './errors.js';

export const MODES = ['chrome', 'drive'];

const SYNC_DELAY = 2_500;
const SYNC_MAX_WAIT = 15_000;
// Chrome 同期の書き込み上限（1 時間に 1,800 回）に届かないよう、同期の間隔を空ける
const MIN_SYNC_INTERVAL = 4_000;
const AUTO_BACKUP_INTERVAL = 60 * 60 * 1000;
const MAX_AUTO_BACKUPS = 12;
const MAX_OTHER_BACKUPS = 10;
// 1 回の同期で取ってくる画像の数。残りは続けてもう一度同期して取る
const IMAGE_FETCH_PER_SYNC = 8;
const MAX_IMAGE_SIDE = 100_000;
export const TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_TRASH = 50;

const trashKey = (id) => `trash:${id}`;

// 画面から受け取った画像を確かめ、バイト数を付けて返す
function checkImage(image) {
  const { type, data, width, height } = image ?? {};
  const validSize = [width, height].every((n) => Number.isInteger(n) && n > 0 && n <= MAX_IMAGE_SIDE);
  if (!IMAGE_TYPES.includes(type) || !isBase64(data) || !data || !validSize) throw new TypeError('画像を読み取れませんでした');
  const bytes = base64ByteLength(data);
  if (bytes > MAX_IMAGE_BYTES) throw new LimitError(`画像が大きすぎます。${MAX_IMAGE_BYTES / 1024 / 1024}MB までです`);
  return { type, data, width, height, bytes };
}

// ゴミ箱の古いもの・多すぎる分を分ける
function splitTrash(list, now) {
  const keep = list.filter((entry) => now - entry.at <= TRASH_TTL).slice(0, MAX_TRASH);
  return { keep, drop: list.filter((entry) => !keep.includes(entry)) };
}

function sameBackup(a, b) {
  return (
    a.memos.length === b.memos.length &&
    a.memos.every((memo, i) => memo.id === b.memos[i].id && memo.text === b.memos[i].text)
  );
}

export class Engine {
  constructor({ local, backends, now = () => Date.now(), autoSync = true }) {
    this.local = local;
    this.backends = backends;
    this.now = now;
    this.autoSync = autoSync;
    this.queue = Promise.resolve();
    this.readyPromise = null;
    this.editSeq = 0;
    this.running = null;
    this.rerun = false;
    this.timer = null;
    this.firstScheduledAt = 0;
    this.lastSyncAt = 0;
  }

  exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  ready() {
    this.readyPromise ??= this.exclusive(async () => {
      const { meta, settings } = await this.local.get(['meta', 'settings']);
      if (!meta) await writeLocalDoc(this.local, createInitialDoc(), null);
      if (!MODES.includes(settings?.mode)) await this.local.set({ settings: { mode: 'chrome' } });
    });
    return this.readyPromise;
  }

  async mode() {
    const { settings } = await this.local.get('settings');
    return MODES.includes(settings?.mode) ? settings.mode : 'chrome';
  }

  // ---- 画面から頼まれる操作 ----

  // at は画面側で付けた編集時刻。画面は自分の保存が戻ってきただけかをこの時刻で見分ける
  async edit(id, text, at) {
    if (!isValidId(id) || typeof text !== 'string') throw new TypeError('不正なメモです');
    if (text.length > MAX_TEXT_LENGTH) {
      throw new LimitError(`1 つのメモは ${MAX_TEXT_LENGTH.toLocaleString()} 文字までです`);
    }
    await this.ready();
    const result = await this.exclusive(async () => {
      const key = memoKey(id);
      const { meta, [key]: prev } = await this.local.get(['meta', key]);
      const now = this.now();
      // 他の端末で消されていたメモに書いた場合は、削除の印より新しい時刻にして生き返らせる
      const prevStamp = prev?.updatedAt ?? meta?.deleted?.[id] ?? 0;
      const requested = Number.isFinite(at) ? Math.min(at, now + 60_000) : now;
      const updatedAt = Math.max(requested, prevStamp + 1);
      const set = { [key]: { text, updatedAt, ...labelOf(prev) }, dirty: true };
      const order = Array.isArray(meta?.order) ? meta.order : [];
      if (!order.includes(id)) {
        const deleted = { ...meta?.deleted };
        delete deleted[id];
        set.meta = {
          order: [...order, id],
          orderUpdatedAt: Math.max(now, (meta?.orderUpdatedAt ?? 0) + 1),
          deleted,
        };
      }
      await this.local.set(set);
      return { updatedAt };
    });
    this.changed();
    return result;
  }

  // group を渡すと、そのグループに入れて作る
  add(group) {
    const name = cleanLabel(group, MAX_GROUP_LENGTH);
    return this.change((doc, now) => {
      if (visibleIds(doc).length >= MAX_MEMOS) throw new LimitError(`メモは ${MAX_MEMOS} 個までです`);
      const id = newId();
      const memo = { text: '', updatedAt: now };
      return {
        doc: {
          ...doc,
          order: [...doc.order, id],
          orderUpdatedAt: Math.max(now, doc.orderUpdatedAt + 1),
          memos: { ...doc.memos, [id]: name ? setLabel(memo, { group: name }, now) : memo },
        },
        result: id,
      };
    });
  }

  // メモの名前・グループ・隠す印を変える。changes に入れた項目だけ変わる（空の文字は「無し」）
  label(id, changes = {}) {
    for (const field of ['name', 'group']) {
      if (changes[field] !== undefined && typeof changes[field] !== 'string') throw new TypeError('名前が不正です');
    }
    return this.change((doc, now) => {
      if (!visibleIds(doc).includes(id)) throw new Error('メモが見つかりません');
      const memo = doc.memos[id];
      const fields = labelFields(memo);
      if (changes.name !== undefined) fields.name = cleanLabel(changes.name, MAX_NAME_LENGTH);
      if (changes.group !== undefined) fields.group = cleanLabel(changes.group, MAX_GROUP_LENGTH);
      if (changes.hidden !== undefined) fields.hidden = changes.hidden === true;
      if (sameLabel(fields, labelFields(memo))) return { doc, result: false };
      return { doc: { ...doc, memos: { ...doc.memos, [id]: setLabel(memo, fields, now) } }, result: true };
    });
  }

  // グループの名前を変える。to が空ならグループを解く（メモはそのまま残る）。返り値は変えたメモの数
  renameGroup(from, to) {
    if (typeof from !== 'string' || typeof to !== 'string') throw new TypeError('グループの名前が不正です');
    const next = cleanLabel(to, MAX_GROUP_LENGTH);
    return this.change((doc, now) => {
      const memos = { ...doc.memos };
      let count = 0;
      for (const id of visibleIds(doc)) {
        const memo = memos[id];
        if (!from || memo.group !== from || next === from) continue;
        memos[id] = setLabel(memo, { ...labelFields(memo), group: next }, now);
        count++;
      }
      return { doc: count ? { ...doc, memos } : doc, result: count };
    });
  }

  remove(id) {
    return this.change(async (doc, now) => {
      const visible = visibleIds(doc);
      if (!visible.includes(id)) return { doc, result: false };
      if (visible.length <= MIN_MEMOS) throw new LimitError('最後のメモは削除できません');
      const memo = doc.memos[id];
      if (memo.text.trim()) await this.saveBackup(doc, 'remove');
      const [trashId = null] = await this.saveToTrash(doc, { memoIds: [id] });
      return {
        doc: {
          order: doc.order.filter((x) => x !== id),
          orderUpdatedAt: Math.max(now, doc.orderUpdatedAt + 1),
          memos: { ...doc.memos, [id]: { text: '', updatedAt: Math.max(now, memo.updatedAt + 1), deleted: true } },
          images: removeImagesOf(doc.images, [id], now),
        },
        result: { trashId },
      };
    });
  }

  // 表示中（最後に開いていた）メモ。無ければ 1 番目
  async currentMemoId(doc) {
    const { ui } = await this.local.get('ui');
    const visible = visibleIds(doc);
    return visible.includes(ui?.currentId) ? ui.currentId : visible[0];
  }

  // 表示中のメモの最後に文字を足す（右クリックの「ちょこメモに送る」）
  async appendText(text) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('送る文字がありません');
    return this.change(async (doc, now) => {
      const memoId = await this.currentMemoId(doc);
      const memo = doc.memos[memoId];
      const next = memo.text.trim() ? `${memo.text.replace(/\s+$/, '')}\n\n${text}` : text;
      if (next.length > MAX_TEXT_LENGTH) throw new LimitError(`1 つのメモは ${MAX_TEXT_LENGTH.toLocaleString()} 文字までです`);
      const memos = { ...doc.memos, [memoId]: { ...memo, text: next, updatedAt: Math.max(now, memo.updatedAt + 1) } };
      return { doc: { ...doc, memos }, result: { memoId } };
    });
  }

  // ids: 画面に見えているメモの新しい並び順（見えているメモをすべて含む）
  reorder(ids) {
    return this.change((doc, now) => {
      const visible = visibleIds(doc);
      const same = Array.isArray(ids) && ids.length === visible.length && visible.every((id) => ids.includes(id));
      if (!same) throw new Error('メモが変わったため並べ替えられませんでした。もう一度お試しください');
      if (ids.every((id, i) => id === visible[i])) return { doc, result: false };
      // 見えていない ID（他の端末から届きかけのメモ）は、今の位置のまま残す
      let next = 0;
      const order = doc.order.map((id) => (visible.includes(id) ? ids[next++] : id));
      return { doc: { ...doc, order, orderUpdatedAt: Math.max(now, doc.orderUpdatedAt + 1) }, result: true };
    });
  }

  async requireDrive() {
    await this.ready();
    if ((await this.mode()) !== 'drive') {
      throw new LimitError('画像は Google ドライブ同期のときに貼れます。設定画面で切り替えてください。');
    }
  }

  // image: { type, data（base64）, width, height }。memoId を省くと表示中のメモ。返り値は画像の ID
  // no は取り込みのときに、ZIP のファイル名にあった番号を引き継ぐため。使われていれば次の番号にする
  async addImage(memoId, image, { no } = {}) {
    if (memoId != null && !isValidId(memoId)) throw new TypeError('画像を読み取れませんでした');
    const { type, data, width, height, bytes } = checkImage(image);
    await this.requireDrive();
    return this.change(async (doc, now) => {
      memoId ??= await this.currentMemoId(doc);
      if (!visibleIds(doc).includes(memoId)) throw new Error('メモが見つかりません');
      const live = Object.values(doc.images).filter((x) => !x.deleted);
      if (live.filter((x) => x.memoId === memoId).length >= MAX_IMAGES_PER_MEMO) {
        throw new LimitError(`1 つのメモに貼れる画像は ${MAX_IMAGES_PER_MEMO} 枚までです`);
      }
      if (live.length >= MAX_IMAGES) throw new LimitError(`画像は全部で ${MAX_IMAGES} 枚までです`);
      const id = newId();
      const taken = new Set(imageNumbers(doc, memoId).values());
      const number = Number.isInteger(no) && no > 0 && !taken.has(no) ? no : nextImageNo(doc, memoId);
      return {
        doc: { ...doc, images: { ...doc.images, [id]: { memoId, addedAt: now, updatedAt: now, type, width, height, bytes, no: number } } },
        extra: { [imageKey(id)]: { type, data } },
        result: id,
      };
    });
  }

  removeImage(id) {
    return this.change(async (doc, now) => {
      const image = doc.images[id];
      if (!image || image.deleted) return { doc, result: { trashId: null } };
      const [trashId = null] = await this.saveToTrash(doc, { imageIds: [id] });
      return { doc: { ...doc, images: { ...doc.images, [id]: imageTombstone(image, now) } }, result: { trashId } };
    });
  }

  // 印を付けた画像で置き換える。元の画像はゴミ箱に入れ、並びの位置は元のまま。
  // 返り値: { id: 新しい画像の ID, trashId: 元の画像を入れたゴミ箱の ID（「元に戻す」用） }
  async replaceImage(id, image) {
    const { type, data, width, height, bytes } = checkImage(image);
    await this.requireDrive();
    return this.change(async (doc, now) => {
      const old = doc.images[id];
      if (!old || old.deleted) throw new Error('画像が見つかりません');
      const [trashId = null] = await this.saveToTrash(doc, { imageIds: [id] });
      const newIdValue = newId();
      const images = {
        ...doc.images,
        [id]: imageTombstone(old, now),
        [newIdValue]: { memoId: old.memoId, addedAt: old.addedAt, updatedAt: now, type, width, height, bytes, no: imageNumbers(doc, old.memoId).get(id) },
      };
      return { doc: { ...doc, images }, extra: { [imageKey(newIdValue)]: { type, data } }, result: { id: newIdValue, trashId } };
    });
  }

  // 印を付けて置き換えた画像 id を、ゴミ箱 trashId に入れた元の画像に戻す（置き換えた直後の「元に戻す」）。
  // 並びの位置はそのまま。印を付けた方もゴミ箱に入れておく。返り値: { id: 戻した画像の ID }
  revertImage(id, trashId) {
    return this.change(async (doc, now) => {
      const key = trashKey(trashId);
      const { [key]: entry } = await this.local.get(key);
      const original = entry?.kind === 'image' ? entry.images[0] : null;
      if (!original) throw new Error('ゴミ箱に見つかりませんでした');
      const current = doc.images[id];
      if (!current || current.deleted) throw new Error('画像が見つかりません');
      await this.saveToTrash(doc, { imageIds: [id] });
      const { trash = [] } = await this.local.get('trash');
      const restored = newId();
      const images = {
        ...doc.images,
        [id]: imageTombstone(current, now),
        [restored]: {
          memoId: current.memoId,
          addedAt: current.addedAt,
          updatedAt: now,
          type: original.type,
          width: original.width,
          height: original.height,
          bytes: base64ByteLength(original.data),
          no: imageNumbers(doc, current.memoId).get(id),
        },
      };
      return {
        doc: { ...doc, images },
        extra: { [imageKey(restored)]: { type: original.type, data: original.data }, trash: trash.filter((item) => item.id !== trashId) },
        removeKeys: [key],
        result: { id: restored },
      };
    });
  }

  // items: [{ text, images? }]。images は後から貼る画像の枚数（画像だけのメモを飛ばさないため）。
  // 'replace' は 1 番目から順に今のメモへ上書き、'append' は末尾に追加。
  // 返り値の ids は items と同じ並びの、取り込んだ先のメモの ID（飛ばしたものは null）
  async importItems(items, strategy) {
    if (!Array.isArray(items) || !['replace', 'append'].includes(strategy)) {
      throw new TypeError('取り込みの指定が不正です');
    }
    items.forEach((item, i) => {
      if (typeof item?.text !== 'string') throw new TypeError('取り込むデータが不正です');
      if (item.images !== undefined && !(Number.isInteger(item.images) && item.images >= 0)) {
        throw new TypeError('取り込むデータが不正です');
      }
      if (item.text.length > MAX_TEXT_LENGTH) {
        throw new LimitError(`${i + 1} 件目のメモが長すぎます。${MAX_TEXT_LENGTH.toLocaleString()} 文字までです`);
      }
    });
    const keep = (item) => strategy !== 'append' || item.text.trim() !== '' || item.images > 0;
    return this.change(async (doc, now) => {
      const visible = visibleIds(doc);
      const count = items.filter(keep).length;
      const total = strategy === 'append' ? visible.length + count : Math.max(visible.length, count);
      if (total > MAX_MEMOS) throw new LimitError(`取り込むとメモが ${total} 個になり、上限の ${MAX_MEMOS} 個を超えます`);
      await this.saveBackup(doc, 'import');
      const memos = { ...doc.memos };
      const order = [...doc.order];
      let next = 0;
      const ids = items.map((item) => {
        if (!keep(item)) return null;
        let id = strategy === 'replace' ? visible[next] : undefined;
        next++;
        if (!id) {
          id = newId();
          order.push(id);
        }
        memos[id] = { ...labelOf(memos[id]), text: item.text, updatedAt: Math.max(now, (memos[id]?.updatedAt ?? 0) + 1) };
        return id;
      });
      return {
        doc: normalizeDoc({ ...doc, order, orderUpdatedAt: Math.max(now, doc.orderUpdatedAt + 1), memos }).doc,
        result: { count, ids },
      };
    });
  }

  // バックアップの状態に戻す。戻す操作も新しい編集として他の端末へ伝わる
  restore(at) {
    return this.change(async (doc, now) => {
      const { backups = [] } = await this.local.get('backups');
      const backup = backups.find((b) => b.at === at);
      if (!backup) throw new Error('バックアップが見つかりません');
      await this.saveBackup(doc, 'restore');
      const memos = { ...doc.memos };
      const order = [];
      for (const { id, text, label } of backup.memos) {
        if (!isValidId(id) || typeof text !== 'string' || order.includes(id)) continue;
        const memo = { ...labelOf(memos[id]), text, updatedAt: Math.max(now, (memos[id]?.updatedAt ?? 0) + 1) };
        // 名前などを覚えているバックアップなら、それも戻す（古いバックアップには無い）
        const keep = !label || typeof label !== 'object' || sameLabel(label, labelFields(memo));
        memos[id] = keep ? memo : setLabel(memo, label, now);
        order.push(id);
      }
      if (!order.length) throw new Error('このバックアップには戻せるメモがありません');
      const removed = visibleIds(doc).filter((id) => !order.includes(id));
      await this.saveToTrash(doc, { memoIds: removed });
      for (const id of removed) {
        memos[id] = { text: '', updatedAt: Math.max(now, doc.memos[id].updatedAt + 1), deleted: true };
      }
      const images = removeImagesOf(doc.images, removed, now);
      return {
        doc: normalizeDoc({ order, orderUpdatedAt: Math.max(now, doc.orderUpdatedAt + 1), memos, images }).doc,
        result: { count: order.length },
      };
    });
  }

  // バックアップの中の 1 つのメモを、新しいメモとして戻す（別の PC と重なって負けた方の内容を取り戻すとき）。
  // 元のメモがまだあれば、そのすぐ後ろに入れる。返り値: { memoId }
  restoreBackupMemo(at, id) {
    return this.change(async (doc, now) => {
      const { backups = [] } = await this.local.get('backups');
      const memo = backups.find((b) => b.at === at)?.memos.find((m) => m.id === id);
      if (!memo || typeof memo.text !== 'string') throw new Error('バックアップの中にメモが見つかりません');
      const visible = visibleIds(doc);
      if (visible.length >= MAX_MEMOS) throw new LimitError(`メモは ${MAX_MEMOS} 個までのため戻せません`);
      const memoId = newId();
      const after = doc.order.indexOf(id);
      const insertAt = visible.includes(id) && after >= 0 ? after + 1 : doc.order.length;
      const order = [...doc.order.slice(0, insertAt), memoId, ...doc.order.slice(insertAt)];
      const base = { text: memo.text, updatedAt: now };
      const label = memo.label && typeof memo.label === 'object' ? memo.label : null;
      const next = label && !sameLabel(label, {}) ? setLabel(base, label, now) : base;
      return {
        doc: { ...doc, order, orderUpdatedAt: Math.max(now, doc.orderUpdatedAt + 1), memos: { ...doc.memos, [memoId]: next } },
        result: { memoId },
      };
    });
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw new TypeError('不明な同期方式です');
    await this.ready();
    await this.exclusive(async () => {
      await this.saveBackup(await readLocalDoc(this.local), 'mode');
      await this.local.set({ settings: { mode } });
    });
    return this.sync();
  }

  async change(fn) {
    await this.ready();
    const result = await this.exclusive(async () => {
      const doc = await readLocalDoc(this.local);
      const out = await fn(doc, this.now());
      await writeLocalDoc(this.local, out.doc, doc, { dirty: true, ...out.extra });
      if (out.removeKeys?.length) await this.local.remove(out.removeKeys);
      return out.result;
    });
    this.changed();
    return result;
  }

  changed() {
    this.editSeq++;
    this.scheduleSync();
  }

  // ---- バックアップ（端末内だけに置く） ----

  // extra は記録に足す項目（重なったときの conflicts: [メモの ID] など）。返り値は取ったバックアップの at（取らなかったら null）
  async saveBackup(doc, reason, extra = {}) {
    const memos = visibleIds(doc).map((id) => ({ id, text: doc.memos[id].text, label: labelFields(doc.memos[id]) }));
    if (!memos.some((memo) => memo.text.trim())) return null;
    const entry = { at: this.now(), reason, memos, ...extra };
    const { backups = [] } = await this.local.get('backups');
    // 重なったときの記録は、中身が同じでも残す（どのメモが重なったかを覚えておくため）
    if (backups[0] && reason !== 'conflict' && sameBackup(backups[0], entry)) return backups[0].at;
    const all = [entry, ...backups];
    const autos = all.filter((b) => b.reason === 'auto').slice(0, MAX_AUTO_BACKUPS);
    const others = all.filter((b) => b.reason !== 'auto').slice(0, MAX_OTHER_BACKUPS);
    await this.local.set({ backups: [...autos, ...others].sort((a, b) => b.at - a.at) });
    return entry.at;
  }

  async autoBackup() {
    await this.ready();
    return this.exclusive(async () => {
      await this.cleanTrash();
      const { backups = [] } = await this.local.get('backups');
      const lastAuto = backups.find((b) => b.reason === 'auto');
      if (lastAuto && this.now() - lastAuto.at < AUTO_BACKUP_INTERVAL) return;
      await this.saveBackup(await readLocalDoc(this.local), 'auto');
    });
  }

  // ---- ゴミ箱（端末内だけに置く） ----

  // 消す前の doc から、メモ（貼った画像ごと）と画像を入れる。exclusive の中で呼ぶ。返り値は入れた ID
  async saveToTrash(doc, { memoIds = [], imageIds = [] }) {
    const wanted = [...memoIds.flatMap((id) => memoImageIds(doc, id)), ...imageIds];
    const blobs = wanted.length ? await this.local.get(wanted.map(imageKey)) : {};
    const copyOf = (id) => {
      const record = doc.images[id];
      const blob = blobs[imageKey(id)];
      if (!record || record.deleted || !blob) return null;
      const no = imageNumbers(doc, record.memoId).get(id);
      return { type: record.type, width: record.width, height: record.height, data: blob.data, no };
    };
    const visible = visibleIds(doc);
    const entries = [];
    for (const memoId of memoIds) {
      const memo = doc.memos[memoId];
      if (!memo || memo.deleted) continue;
      const images = memoImageIds(doc, memoId).map(copyOf).filter(Boolean);
      if (!memo.text.trim() && !images.length) continue;
      entries.push({ kind: 'memo', text: memo.text, label: labelFields(memo), position: visible.indexOf(memoId), images });
    }
    for (const imageId of imageIds) {
      const image = copyOf(imageId);
      if (image) entries.push({ kind: 'image', memoId: doc.images[imageId].memoId, images: [image] });
    }
    if (!entries.length) return [];
    const now = this.now();
    const set = {};
    const added = entries.map((entry) => {
      const id = newId();
      set[trashKey(id)] = entry;
      // 隠していたメモは、ゴミ箱の一覧にも本文を出さない
      const memo = entry.kind === 'memo' ? { text: entry.text, ...entry.label } : (doc.memos[entry.memoId] ?? { text: '' });
      return {
        id,
        at: now,
        kind: entry.kind,
        title: displayTitle(memo, 40),
        hidden: !!memo.hidden,
        chars: entry.kind === 'memo' ? [...entry.text].length : 0,
        images: entry.images.length,
      };
    });
    const { trash = [] } = await this.local.get('trash');
    const { keep, drop } = splitTrash([...added, ...trash], now);
    await this.local.set({ ...set, trash: keep });
    if (drop.length) await this.local.remove(drop.map((entry) => trashKey(entry.id)));
    return added.filter((entry) => keep.includes(entry)).map((entry) => entry.id);
  }

  async cleanTrash() {
    const { trash = [] } = await this.local.get('trash');
    const { keep, drop } = splitTrash(trash, this.now());
    if (!drop.length) return;
    await this.local.set({ trash: keep });
    await this.local.remove(drop.map((entry) => trashKey(entry.id)));
  }

  // ゴミ箱から戻す。メモは元の位置に新しいメモとして、画像は元のメモ（無ければ新しいメモ）に戻す。
  // 画像はどちらの同期方式でも戻す（Chrome 同期のときは、この PC にだけ残る）
  restoreTrash(trashId) {
    return this.change(async (doc, now) => {
      const key = trashKey(trashId);
      const { trash = [], [key]: entry } = await this.local.get(['trash', key]);
      if (!entry) throw new Error('ゴミ箱に見つかりませんでした');
      const visible = visibleIds(doc);
      let memoId = entry.kind === 'image' && visible.includes(entry.memoId) ? entry.memoId : null;
      let { order, orderUpdatedAt } = doc;
      const memos = { ...doc.memos };
      if (!memoId) {
        if (visible.length >= MAX_MEMOS) throw new LimitError(`メモは ${MAX_MEMOS} 個までのため戻せません`);
        memoId = newId();
        const before = visible[entry.position];
        const at = before ? doc.order.indexOf(before) : doc.order.length;
        order = [...doc.order.slice(0, at), memoId, ...doc.order.slice(at)];
        orderUpdatedAt = Math.max(now, doc.orderUpdatedAt + 1);
        const memo = { text: entry.text ?? '', updatedAt: now };
        memos[memoId] = entry.label && !sameLabel(entry.label, {}) ? setLabel(memo, entry.label, now) : memo;
      }
      const live = Object.values(doc.images).filter((image) => !image.deleted);
      const inMemo = live.filter((image) => image.memoId === memoId).length;
      if (inMemo + entry.images.length > MAX_IMAGES_PER_MEMO || live.length + entry.images.length > MAX_IMAGES) {
        throw new LimitError('画像の枚数の上限を超えるため戻せません');
      }
      const images = { ...doc.images };
      const extra = { trash: trash.filter((item) => item.id !== trashId) };
      // 番号は元のまま戻す（本文の [画像 1] の印がまた同じ画像を指す）。もう使われていれば次の番号にする
      const taken = new Set(imageNumbers(doc, memoId).values());
      let next = nextImageNo(doc, memoId);
      entry.images.forEach((image, i) => {
        const id = newId();
        const bytes = base64ByteLength(image.data);
        const no = Number.isInteger(image.no) && image.no > 0 && !taken.has(image.no) ? image.no : next++;
        taken.add(no);
        if (no >= next) next = no + 1;
        images[id] = { memoId, addedAt: now + i, updatedAt: now, type: image.type, width: image.width, height: image.height, bytes, no };
        extra[imageKey(id)] = { type: image.type, data: image.data };
      });
      return { doc: { ...doc, order, orderUpdatedAt, memos, images }, extra, removeKeys: [key], result: { memoId } };
    });
  }

  // trashId を省くと全部
  async deleteTrash(trashId) {
    await this.ready();
    return this.exclusive(async () => {
      const { trash = [] } = await this.local.get('trash');
      const gone = trash.filter((entry) => trashId == null || entry.id === trashId);
      await this.local.set({ trash: trash.filter((entry) => !gone.includes(entry)) });
      if (gone.length) await this.local.remove(gone.map((entry) => trashKey(entry.id)));
      return gone.length;
    });
  }

  // ---- 同期 ----

  sync() {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.clearTimer();
    this.running = (async () => {
      let status;
      try {
        do {
          this.rerun = false;
          status = await this.syncOnce();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
      return status;
    })();
    return this.running;
  }

  async syncOnce() {
    await this.ready();
    const mode = await this.mode();
    const backend = this.backends[mode];
    const seq = this.editSeq;
    this.lastSyncAt = this.now();
    await this.setStatus({ state: 'syncing', mode });
    try {
      const remote = await backend.pull();
      const merged = await this.exclusive(async () => {
        const before = await readLocalDoc(this.local);
        const result = mergeDocs(before, remote.doc);
        const cleaned = dropOldTombstones(result.doc, this.now());
        // 同期方式を切り替えた直後は比べる相手が違うので見ない（切り替えの前にバックアップを取っている）
        const { synced } = await this.local.get('synced');
        const conflicts =
          synced?.mode === mode ? findConflicts(before, remote.doc, cleaned.doc, synced.memos ?? {}) : { ids: [] };
        if (conflicts.ids.length) {
          const backupAt = await this.saveBackup(conflicts.lost, 'conflict', { conflicts: conflicts.ids });
          const titles = conflicts.ids.map((id) => displayTitle(conflicts.lost.memos[id]));
          await this.local.set({ alert: { kind: 'conflict', at: this.now(), titles, ids: conflicts.ids, backupAt } });
        } else if (losesContent(before, cleaned.doc)) {
          await this.saveBackup(before, 'sync');
        }
        // 他の端末で消されたメモと画像は、この PC にある中身ごとゴミ箱に入れる
        const isGone = (item) => !item || item.deleted;
        const goneMemos = visibleIds(before).filter((id) => isGone(cleaned.doc.memos[id]));
        const visibleBefore = visibleIds(before);
        const goneImages = Object.entries(before.images)
          .filter(([id, image]) => !image.deleted && isGone(cleaned.doc.images[id]))
          .filter(([, image]) => visibleBefore.includes(image.memoId) && !goneMemos.includes(image.memoId))
          .map(([id]) => id);
        if (goneMemos.length || goneImages.length) await this.saveToTrash(before, { memoIds: goneMemos, imageIds: goneImages });
        await writeLocalDoc(this.local, cleaned.doc, before);
        return { doc: cleaned.doc, dropped: [...result.dropped, ...cleaned.dropped] };
      });
      await backend.push(merged.doc, remote, merged.dropped, {
        loadImage: (id) => this.loadImage(id),
        now: this.now(),
      });
      // 同期先と揃えた版を覚えておく。Chrome 同期で一部しか届いていないメモは、まだ揃っていない
      const memos = {};
      for (const [id, memo] of Object.entries(merged.doc.memos)) {
        if (!remote.pending?.has(id)) memos[id] = memo.updatedAt;
      }
      await this.local.set({ synced: { mode, memos } });
      if (seq === this.editSeq) await this.local.set({ dirty: false });
      if (await this.fetchImages(backend, remote, merged.doc)) this.rerun = true;
      return await this.setStatus({ state: 'ok', mode, at: this.now() });
    } catch (error) {
      const state = error instanceof AuthError ? 'auth' : 'error';
      const kind = error instanceof QuotaError ? 'quota' : error instanceof RemoteError ? 'remote' : state;
      return this.setStatus({ state, mode, at: this.now(), message: error.message, kind });
    }
  }

  // Google ドライブの使用量（このアプリの分と、ドライブ全体）
  async driveUsage() {
    await this.ready();
    if ((await this.mode()) !== 'drive') throw new Error('Google ドライブ同期のときだけ見られます');
    return this.backends.drive.usage();
  }

  async loadImage(id) {
    const key = imageKey(id);
    return (await this.local.get(key))[key] ?? null;
  }

  // 同期先にあって、この PC にまだ無い画像の本体を取ってくる。まだ残っていれば true
  async fetchImages(backend, remote, doc) {
    if (!backend.downloadImage) return false;
    let fetched = 0;
    for (const [id, image] of Object.entries(doc.images)) {
      if (image.deleted || !remote.blobs?.has(id)) continue;
      if ((await this.local.getBytesInUse(imageKey(id))) > 0) continue;
      if (fetched >= IMAGE_FETCH_PER_SYNC) return true;
      let blob;
      try {
        blob = await backend.downloadImage(remote, id, image);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        continue; // 次の同期でもう一度試す
      }
      if (!blob) continue;
      // 取ってくる間に消された画像の本体は置かない
      await this.exclusive(async () => {
        const { images } = await this.local.get('images');
        if (images?.[id] && !images[id].deleted) await this.local.set({ [imageKey(id)]: blob });
      });
      fetched++;
    }
    return false;
  }

  // kind は失敗の種類（'auth' | 'quota' | 'remote' | 'error'）。画面はこれで次にすることを決める
  async setStatus({ state, mode, at, message, kind }) {
    const { status: prev } = await this.local.get('status');
    const sameMode = prev?.mode === mode;
    const status = {
      state,
      mode,
      at: at ?? (sameMode ? prev?.at : null) ?? null,
      message: message ?? null,
      kind: kind ?? null,
      lastOkAt: state === 'ok' ? at : sameMode ? (prev?.lastOkAt ?? null) : null,
    };
    await this.local.set({ status });
    return status;
  }

  scheduleSync(delay = SYNC_DELAY) {
    if (!this.autoSync) return;
    const now = this.now();
    if (this.timer) clearTimeout(this.timer);
    else this.firstScheduledAt = now;
    const due = Math.max(
      Math.min(now + delay, this.firstScheduledAt + SYNC_MAX_WAIT),
      this.lastSyncAt + MIN_SYNC_INTERVAL,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sync();
    }, due - now);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // Chrome 同期の領域が他の端末によって変わったとき
  async onRemoteChange(changes) {
    // グループの色など、メモ以外の同期データの変化では同期しない
    const memoKeys = Object.keys(changes).filter((key) => key === 'meta' || key.startsWith('h:') || key.startsWith('c:'));
    if (!memoKeys.length) return;
    if ((await this.mode()) !== 'chrome') return;
    if (this.backends.chrome.isOwnChange?.(changes)) return;
    this.scheduleSync(800);
  }

  async onAlarm(name) {
    if (name === 'flush') {
      const { dirty } = await this.local.get('dirty');
      if (dirty) await this.sync();
    } else if (name === 'poll') {
      if ((await this.mode()) === 'drive') await this.sync();
      await this.autoBackup();
    }
  }
}

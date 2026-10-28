import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialDoc,
  dropOldTombstones,
  losesContent,
  mergeDocs,
  sanitizeDoc,
  TOMBSTONE_TTL,
  visibleIds,
} from '../extension/lib/model.js';

const doc = (order, memos, orderUpdatedAt = 1) => ({ order, orderUpdatedAt, memos });

test('メモごとに新しい方が採用される', () => {
  const local = doc(['aaaa', 'bbbb'], { aaaa: { text: 'local', updatedAt: 5 }, bbbb: { text: 'old', updatedAt: 1 } });
  const remote = doc(['aaaa', 'bbbb'], { aaaa: { text: 'remote', updatedAt: 3 }, bbbb: { text: 'new', updatedAt: 9 } });
  const { doc: merged } = mergeDocs(local, remote);
  assert.equal(merged.memos.aaaa.text, 'local');
  assert.equal(merged.memos.bbbb.text, 'new');
});

test('引数の順番を入れ替えても同じ結果になる', () => {
  const a = doc(['aaaa', 'cccc'], { aaaa: { text: 'x', updatedAt: 4 }, cccc: { text: 'c', updatedAt: 2 } }, 7);
  const b = doc(['bbbb', 'aaaa'], { aaaa: { text: 'y', updatedAt: 4 }, bbbb: { text: 'b', updatedAt: 3 } }, 7);
  assert.deepEqual(mergeDocs(a, b), mergeDocs(b, a));
});

test('削除の印は古い編集より優先され、並び順からも消える', () => {
  const local = doc(['aaaa', 'bbbb'], { aaaa: { text: 'keep', updatedAt: 1 }, bbbb: { text: 'edited', updatedAt: 2 } }, 1);
  const remote = doc(['aaaa'], { aaaa: { text: 'keep', updatedAt: 1 }, bbbb: { text: '', updatedAt: 3, deleted: true } }, 3);
  const { doc: merged } = mergeDocs(local, remote);
  assert.deepEqual(visibleIds(merged), ['aaaa']);
  assert.equal(merged.memos.bbbb.deleted, true);
});

test('削除より後の編集はメモを生き返らせ、末尾に並ぶ', () => {
  const local = doc(['aaaa', 'bbbb'], { aaaa: { text: 'a', updatedAt: 1 }, bbbb: { text: 'still here', updatedAt: 9 } }, 1);
  const remote = doc(['aaaa'], { aaaa: { text: 'a', updatedAt: 1 }, bbbb: { text: '', updatedAt: 5, deleted: true } }, 5);
  const { doc: merged } = mergeDocs(local, remote);
  assert.deepEqual(visibleIds(merged), ['aaaa', 'bbbb']);
  assert.equal(merged.memos.bbbb.text, 'still here');
});

test('一度も編集していない初期メモは、相手の並び順が勝てば捨てられる', () => {
  const fresh = createInitialDoc();
  const remote = doc(['aaaa'], { aaaa: { text: 'hello', updatedAt: 10 } }, 10);
  const { doc: merged, dropped } = mergeDocs(fresh, remote);
  assert.deepEqual(visibleIds(merged), ['aaaa']);
  assert.equal(dropped.length, 3);
});

test('並び順の時刻が同じなら、書かれたメモを多く含む並びが残る', () => {
  const existing = createInitialDoc();
  existing.memos[existing.order[0]] = { text: '既存の端末で書いた', updatedAt: 5 };
  existing.memos[existing.order[2]] = { text: 'もう1つ', updatedAt: 6 };
  for (let i = 0; i < 20; i++) {
    const fresh = createInitialDoc();
    fresh.memos[fresh.order[0]] = { text: '同期が届く前に書いた', updatedAt: 7 };
    const { doc: merged } = mergeDocs(fresh, existing);
    assert.deepEqual(visibleIds(merged), [...existing.order, fresh.order[0]]);
  }
});

test('編集済みのメモは相手の並び順に無くても残る', () => {
  const local = doc(['zzzz'], { zzzz: { text: 'mine', updatedAt: 2 } }, 1);
  const remote = doc(['aaaa'], { aaaa: { text: 'theirs', updatedAt: 3 } }, 5);
  const { doc: merged } = mergeDocs(local, remote);
  assert.deepEqual(visibleIds(merged), ['aaaa', 'zzzz']);
});

test('古い削除済みの印は片付けられる', () => {
  const now = 10 * TOMBSTONE_TTL;
  const d = doc([], { aaaa: { text: '', updatedAt: now - TOMBSTONE_TTL - 1, deleted: true }, bbbb: { text: '', updatedAt: now - 5, deleted: true } });
  const { doc: cleaned, dropped } = dropOldTombstones(d, now);
  assert.deepEqual(dropped, ['aaaa']);
  assert.ok(cleaned.memos.bbbb);
});

test('壊れたデータや危ない ID は取り込まない', () => {
  const raw = JSON.parse('{"order":["aaaa","__proto__","Bad!"],"orderUpdatedAt":"x","memos":{"__proto__":{"text":"x","updatedAt":1},"aaaa":{"text":"ok","updatedAt":1},"bbbb":{"text":5,"updatedAt":1},"cccc":{"text":"t","updatedAt":-1}}}');
  const clean = sanitizeDoc(raw);
  assert.deepEqual(clean.order, ['aaaa']);
  assert.equal(clean.orderUpdatedAt, 0);
  assert.deepEqual(Object.keys(clean.memos), ['aaaa']);
  assert.equal(Object.getPrototypeOf(clean.memos), Object.prototype);
  assert.equal(sanitizeDoc('nope'), null);
});

test('中身が消えたり半分以下になったりする統合を検知する', () => {
  const before = doc(['aaaa'], { aaaa: { text: '長いメモの本文です', updatedAt: 1 } });
  assert.equal(losesContent(before, doc(['aaaa'], { aaaa: { text: '長いメモの本文ですよ', updatedAt: 2 } })), false);
  assert.equal(losesContent(before, doc(['aaaa'], { aaaa: { text: '長い', updatedAt: 2 } })), true);
  assert.equal(losesContent(before, doc([], { aaaa: { text: '', updatedAt: 2, deleted: true } })), true);
});

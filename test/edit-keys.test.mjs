// キー操作で本文を書き換える処理：⌘B などの書式と、Tab の字下げ

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, indentLines, toggleInline } from '../extension/lib/edit-keys.js';

// 書き換えた後の本文と、選んでいる文字
function run(text, anchor, head, edit) {
  const result = edit(text, anchor, head);
  if (!result) return null;
  const next = applyChanges(text, result.changes);
  const { anchor: a, head: h } = result.selection;
  return [next, next.slice(Math.min(a, h), Math.max(a, h))];
}
const inline = (kind) => (text, a, h) => toggleInline(text, a, h, kind);

test('選んだ文字を包み、もう一度押すと外す。前後の空白は包まない', () => {
  assert.deepEqual(run('今日は 牛乳 を買う', 4, 6, inline('bold')), ['今日は **牛乳** を買う', '牛乳']);
  assert.deepEqual(run('今日は 牛乳 を買う', 3, 7, inline('bold')), ['今日は **牛乳** を買う', '牛乳']);
  assert.deepEqual(run('今日は **牛乳** を買う', 6, 8, inline('bold')), ['今日は 牛乳 を買う', '牛乳']);
  // 記号ごと選んでいても外す
  assert.deepEqual(run('今日は **牛乳** を買う', 4, 10, inline('bold')), ['今日は 牛乳 を買う', '牛乳']);
  // 書式の中にカーソルがあるだけでも外す
  assert.deepEqual(run('今日は **牛乳** を買う', 7, 7, inline('bold')), ['今日は 牛乳 を買う', '']);
  assert.deepEqual(run('a b', 0, 1, inline('italic')), ['*a* b', 'a']);
  assert.deepEqual(run('a b', 2, 3, inline('strike')), ['a ~~b~~', 'b']);
  assert.deepEqual(run('a b', 2, 3, inline('code')), ['a `b`', 'b']);
  // 後ろから選んでも同じ
  assert.deepEqual(run('今日は 牛乳 を買う', 6, 4, inline('bold')), ['今日は **牛乳** を買う', '牛乳']);
});

test('太字と斜体を重ねても、片方だけを外せる', () => {
  assert.deepEqual(run('**牛乳**', 2, 4, inline('italic')), ['***牛乳***', '牛乳']);
  assert.deepEqual(run('***牛乳***', 4, 4, inline('italic')), ['**牛乳**', '']);
  assert.deepEqual(run('***牛乳***', 4, 4, inline('bold')), ['*牛乳*', '']);
});

test('何も選んでいなければ記号を 2 つ入れ、もう一度押すと消す', () => {
  const [next] = run('a b', 1, 1, inline('bold'));
  assert.equal(next, 'a**** b');
  assert.deepEqual(run(next, 3, 3, inline('bold')), ['a b', '']);
});

test('何行かにまたがって選んだら、行ごとに包む', () => {
  assert.deepEqual(run('一行目\n二行目\n', 0, 8, inline('strike')), ['~~一行目~~\n~~二行目~~\n', '一行目~~\n~~二行目']);
  assert.deepEqual(run('~~一行目~~\n~~二行目~~', 2, 15, inline('strike')), ['一行目\n二行目', '一行目\n二行目']);
  assert.equal(toggleInline('a\n  \nb', 2, 4, 'bold'), null);
});

test('Tab で字下げを深くし、Shift+Tab で浅くする。カーソルは文字と一緒に動く', () => {
  assert.deepEqual(run('- a\n- b', 7, 7, (t, a, h) => indentLines(t, a, h)), ['- a\n  - b', '']);
  assert.deepEqual(indentLines('- a\n- b', 7, 7).selection, { anchor: 9, head: 9 });
  assert.deepEqual(run('- a\n  - b', 9, 9, (t, a, h) => indentLines(t, a, h, { outdent: true })), ['- a\n- b', '']);
  // 何行か選んだら、まとめて字下げする。空の行は飛ばす。次の行の頭までの選択は、その行を入れない
  assert.deepEqual(run('- a\n\n- b\n- c', 0, 9, (t, a, h) => indentLines(t, a, h)), ['  - a\n\n  - b\n- c', '- a\n\n  - b\n']);
  // 引用の中では > の後ろで字下げする
  assert.deepEqual(run('> - a', 5, 5, (t, a, h) => indentLines(t, a, h)), ['>   - a', '']);
  // 浅くするときは、タブと全角の空白は 1 文字、半角の空白は 2 つまで外す
  assert.deepEqual(run('\t- a\n　b\n   c', 0, 12, (t, a, h) => indentLines(t, a, h, { outdent: true }))[0], '- a\nb\n c');
  // 外す字下げが無ければ何もしない
  assert.equal(indentLines('- a', 0, 0, { outdent: true }), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignGroupColors, cleanGroupColors, renameGroupColor } from '../extension/lib/group-colors.js';

test('選んだ色はそのまま、選んでいないグループには使われていない色を順に割り当てる', () => {
  assert.deepEqual(assignGroupColors(['仕事', '家', '趣味']), { 仕事: 'blue', 家: 'orange', 趣味: 'green' });
  // 「家」に青を選ぶと、ほかのグループは青以外から順に
  assert.deepEqual(assignGroupColors(['仕事', '家', '趣味'], { 家: 'blue' }), { 仕事: 'orange', 家: 'blue', 趣味: 'green' });
  // 9 つ目からは重なる
  const names = Array.from({ length: 9 }, (_, i) => `g${i}`);
  assert.equal(assignGroupColors(names).g8, 'blue');
});

test('読んだ色の記録は形を確かめ、名前を変えたら色もついていく', () => {
  assert.deepEqual(cleanGroupColors({ 仕事: 'red', 家: 'neon', '': 'blue', ['x'.repeat(31)]: 'gray' }), { 仕事: 'red' });
  assert.deepEqual(cleanGroupColors(null), {});
  assert.deepEqual(renameGroupColor({ 仕事: 'red', 家: 'blue' }, '仕事', '会社'), { 家: 'blue', 会社: 'red' });
  assert.deepEqual(renameGroupColor({ 仕事: 'red' }, '仕事', ''), {});
  assert.deepEqual(renameGroupColor({ 家: 'blue' }, '仕事', '会社'), { 家: 'blue' });
});

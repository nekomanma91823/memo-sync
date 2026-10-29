import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGroupOrder, placeGroup, renameGroupOrder, sortGroups, stepGroup } from '../extension/lib/group-order.js';

test('並べ替えた順を先に、並べ替えていないグループはメモの並びの順で後ろに足す', () => {
  assert.deepEqual(sortGroups(['仕事', '家', '趣味']), ['仕事', '家', '趣味']);
  assert.deepEqual(sortGroups(['仕事', '家', '趣味'], ['趣味', '仕事']), ['趣味', '仕事', '家']);
  // やめたグループの名前が記録に残っていても、出さない
  assert.deepEqual(sortGroups(['仕事', '家'], ['旅行', '家']), ['家', '仕事']);
});

test('ドラッグで落とした場所の前か後ろに動かす', () => {
  const shown = ['仕事', '家', '趣味'];
  assert.deepEqual(placeGroup(shown, '趣味', '仕事'), ['趣味', '仕事', '家']);
  assert.deepEqual(placeGroup(shown, '仕事', '趣味', true), ['家', '趣味', '仕事']);
  assert.deepEqual(placeGroup(shown, '仕事', '家', true), ['家', '仕事', '趣味']);
  // 自分の上や、知らない名前には動かさない
  assert.equal(placeGroup(shown, '家', '家'), shown);
  assert.equal(placeGroup(shown, '旅行', '家'), shown);
});

test('左右に 1 つずつ動かし、端から先には動かさない', () => {
  const shown = ['仕事', '家', '趣味'];
  assert.deepEqual(stepGroup(shown, '家', -1), ['家', '仕事', '趣味']);
  assert.deepEqual(stepGroup(shown, '家', 1), ['仕事', '趣味', '家']);
  assert.equal(stepGroup(shown, '仕事', -1), shown);
  assert.equal(stepGroup(shown, '趣味', 1), shown);
});

test('読んだ並びの形を確かめ、名前を変えたら同じ場所に置く', () => {
  assert.deepEqual(cleanGroupOrder(['仕事', '', 3, '仕事', 'x'.repeat(31), '家']), ['仕事', '家']);
  assert.deepEqual(cleanGroupOrder({ 仕事: 1 }), []);
  assert.deepEqual(renameGroupOrder(['仕事', '家', '趣味'], '家', '自宅'), ['仕事', '自宅', '趣味']);
  // 記録に残っていた同じ名前は 1 つにまとめる
  assert.deepEqual(renameGroupOrder(['自宅', '仕事', '家'], '家', '自宅'), ['仕事', '自宅']);
  const order = ['仕事'];
  assert.equal(renameGroupOrder(order, '家', '自宅'), order);
});

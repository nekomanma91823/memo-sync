import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceMemos, replaceOne, searchMemos } from '../extension/lib/search.js';

const doc = (texts) => {
  const order = texts.map((_, i) => `memo${i}`);
  const memos = Object.fromEntries(texts.map((text, i) => [`memo${i}`, { text, updatedAt: 1 }]));
  return { order, orderUpdatedAt: 1, memos, images: {} };
};

test('大文字と小文字・全角と半角・ひらがなとカタカナを区別しない', () => {
  const d = doc(['会議のメモ\nＧｏｏｇｌｅ ドライブ', 'google の件']);
  assert.equal(searchMemos(d, 'めも').results.length, 1);
  const found = searchMemos(d, 'GOOGLE').results;
  assert.deepEqual(found.map((r) => [r.number, r.match]), [[1, 'Ｇｏｏｇｌｅ'], [2, 'google']]);
  assert.equal(searchMemos(d, 'どらいぶ').results.length, 1);
  const [half] = searchMemos(doc(['ﾒﾓｼﾝｸのﾄﾞﾗｲﾌﾞ']), 'ドライブ').results;
  assert.equal(half.match, 'ﾄﾞﾗｲﾌﾞ');
  assert.equal(searchMemos(d, 'ﾄﾞﾗｲﾌﾞ').results.length, 1);
});

test('見つけた位置は元の本文での位置で、選択にそのまま使える', () => {
  const text = '😀 絵文字のあと\n２行目の ＡＢＣ です';
  const [result] = searchMemos(doc([text]), 'abc').results;
  assert.equal(text.slice(result.start, result.end), 'ＡＢＣ');
  assert.equal(result.before, '２行目の ');
  assert.equal(result.after, ' です');
});

test('長い行は見つけた箇所の前後だけを出し、件数の上限を超えたら知らせる', () => {
  const long = `${'あ'.repeat(100)}目印${'い'.repeat(200)}`;
  const [result] = searchMemos(doc([long]), '目印').results;
  assert.ok(result.before.startsWith('…') && result.after.endsWith('…'));
  assert.ok(result.before.length < 40 && result.after.length < 90);

  const many = searchMemos(doc(['x'.repeat(150)]), 'x', { limit: 100 });
  assert.equal(many.results.length, 100);
  assert.equal(many.more, true);
  assert.deepEqual(searchMemos(doc(['abc']), '   ').results, []);
});

test('削除したメモは探さず、本文が変われば新しい本文で探す', () => {
  const d = doc(['りんご', 'みかん']);
  d.memos.memo1 = { text: '', updatedAt: 2, deleted: true };
  d.order = ['memo0'];
  assert.equal(searchMemos(d, 'みかん').results.length, 0);
  d.memos.memo0 = { text: 'りんごとみかん', updatedAt: 3 };
  assert.equal(searchMemos(d, 'みかん').results.length, 1);
});

test('前の版で付けた名前では探さず、隠しているメモは探さずに数だけ返す', () => {
  const d = doc(['本文には無い', '秘密の本文', 'ふつう']);
  d.memos.memo0.name = '請求書の控え';
  d.memos.memo1.hidden = true;
  assert.equal(searchMemos(d, '請求書').results.length, 0);
  assert.equal(searchMemos(d, '秘密').results.length, 0);
  assert.equal(searchMemos(d, '秘密').hidden, 1);
});

test('すべて置換：探すときと同じ区別しない決まりで、隠しているメモは置き換えない', () => {
  const d = doc(['会議のメモ\nメモ帳', 'ﾒﾓ と めも', '関係ない', '隠したメモ']);
  d.memos.memo3.hidden = true;
  const changes = replaceMemos(d, 'めも', 'ノート');
  assert.deepEqual(
    changes.map(({ id, number, text, count }) => [id, number, text, count]),
    [
      ['memo0', 1, '会議のノート\nノート帳', 2],
      ['memo1', 2, 'ノート と ノート', 2],
    ],
  );
  assert.equal(changes[0].previous, '会議のメモ\nメモ帳');
  // 空にすれば消す。前後の空白は探す文字に含めない
  assert.equal(replaceMemos(doc(['a-b-c']), ' - ', '')[0].text, 'abc');
  // 変わらないメモは返さない
  assert.deepEqual(replaceMemos(doc(['メモ']), 'メモ', 'メモ'), []);
  assert.deepEqual(replaceMemos(doc(['メモ']), '  ', 'x'), []);
});

test('1 件だけ置換：結果の場所だけを置き換え、本文が変わっていたら置き換えない', () => {
  const d = doc(['犬と犬と犬']);
  const [, second] = searchMemos(d, '犬').results;
  const change = replaceOne(d, '犬', '猫', second);
  assert.equal(change.text, '犬と猫と犬');
  assert.equal(change.count, 1);
  d.memos.memo0 = { text: '犬と', updatedAt: 2 };
  assert.equal(replaceOne(d, '犬', '猫', second), null);
});

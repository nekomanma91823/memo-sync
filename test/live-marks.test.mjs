// 書式を付けて表示している間の入力欄で、どこに書式を付け、どの記号を隠すか

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRevealed, liveMarks } from '../extension/lib/live-marks.js';

// 部品を [種類, 書式, 本文のその部分] にして読みやすくする
function marks(text, kinds) {
  return liveMarks(text)
    .filter((m) => !kinds || kinds.includes(m.kind))
    .map((m) => (m.kind === 'line' ? [m.kind, m.cls, m.line] : [m.kind, m.cls ?? '', text.slice(m.from, m.to)]));
}

test('見出しは行に書式を付け、# と後ろの # を隠す。全角の空白の後ろでも見出しにする', () => {
  assert.deepEqual(marks('## 予定 ##'), [
    ['line', 'h2', 0],
    ['hide', '', '## '],
    ['hide', '', ' ##'],
  ]);
  assert.deepEqual(marks('#　全角', ['line', 'hide']), [
    ['line', 'h1', 0],
    ['hide', '', '#　'],
  ]);
  // 見出しの記号は、カーソルが行のどこにあっても見せる
  const [, hide] = liveMarks('# 見出し');
  assert.deepEqual(hide.reveal, [0, 5]);
});

test('太字・斜体・取り消し・コードは書式を付け、前後の記号だけを隠す', () => {
  assert.deepEqual(marks('a **太字** と *斜体* と ~~消す~~ と `x`', ['style', 'hide']).filter(([, cls]) => cls !== 'marker'), [
    ['style', 'strong', '**太字**'],
    ['hide', '', '**'],
    ['hide', '', '**'],
    ['style', 'em', '*斜体*'],
    ['hide', '', '*'],
    ['hide', '', '*'],
    ['style', 'del', '~~消す~~'],
    ['hide', '', '~~'],
    ['hide', '', '~~'],
    ['style', 'code', '`x`'],
    ['hide', '', '`'],
    ['hide', '', '`'],
  ]);
  // 記号は、その部品にカーソルが触れたときだけ見せる
  const hide = liveMarks('前 **太字** 後').find((m) => m.kind === 'hide');
  assert.deepEqual(hide.reveal, [2, 8]);
  // 日本語向けの決まりも同じ：記号のすぐ内側にかっこがあっても太字にする
  assert.deepEqual(marks('**「太字」**です', ['style']).filter(([, cls]) => cls === 'strong'), [['style', 'strong', '**「太字」**']]);
});

test('リンクは文字に書式を付け、URL を隠す。開けない URL は書式にしない', () => {
  const items = liveMarks('[お店](https://example.com) と https://a.jp');
  const links = items.filter((m) => m.cls === 'link');
  assert.deepEqual(
    links.map((m) => [m.href, m.reveal]),
    [
      ['https://example.com/', [0, 25]],
      ['https://a.jp/', [28, 40]],
    ],
  );
  assert.deepEqual(marks('[お店](https://example.com)', ['hide']), [
    ['hide', '', '['],
    ['hide', '', '](https://example.com)'],
  ]);
  assert.equal(liveMarks('[x](javascript:alert(1))').filter((m) => m.cls === 'link').length, 0);
});

test('箇条書きは記号を点に、チェックボックスは記号ごと置き換える。番号は残す', () => {
  assert.deepEqual(marks('- 項目\n- [x] 済み\n1. [ ] 番号\n2. 次', ['bullet', 'task', 'style']), [
    ['bullet', '', '-'],
    ['task', '', '- [x]'],
    ['style', 'done', ' 済み'],
    ['task', '', '[ ]'],
  ]);
  const task = liveMarks('- [ ] a\n- [x] b').filter((m) => m.kind === 'task');
  assert.deepEqual(
    task.map((m) => [m.checked, m.line]),
    [
      [false, 0],
      [true, 1],
    ],
  );
  // 入れ子の項目と、項目の続きの行も読む
  assert.deepEqual(marks('- 親\n  - **子**\n  続き *斜*', ['bullet', 'style']).filter(([, cls]) => cls !== 'marker'), [
    ['bullet', '', '-'],
    ['bullet', '', '-'],
    ['style', 'strong', '**子**'],
    ['style', 'em', '*斜*'],
  ]);
});

test('引用は行に書式を付けて > を隠し、中の書式も読む', () => {
  assert.deepEqual(marks('> 引用 **太**\n> - 項目', ['line', 'hide', 'bullet']), [
    ['line', 'quote', 0],
    ['hide', '', '> '],
    ['line', 'quote', 1],
    ['hide', '', '> '],
    ['hide', '', '**'],
    ['hide', '', '**'],
    ['bullet', '', '-'],
  ]);
});

test('コード・表・区切り線・画像の印', () => {
  // コードの中は書式にしない
  assert.deepEqual(marks('```\n**x**\n```'), [
    ['line', 'fence', 0],
    ['line', 'codeblock', 1],
    ['line', 'fence', 2],
  ]);
  // 閉じていないコードは、最後の行もコード
  assert.deepEqual(marks('```\na'), [
    ['line', 'fence', 0],
    ['line', 'codeblock', 1],
  ]);
  const table = liveMarks('前\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n後').find((m) => m.kind === 'table');
  assert.equal(table.block.rows.length, 1);
  assert.deepEqual([table.from, table.to], [3, 32]);
  assert.deepEqual(marks('---', ['hr']), [['hr', '', '---']]);
  const image = liveMarks('写真 [画像 2]').find((m) => m.kind === 'image');
  assert.deepEqual([image.no, image.from, image.to], [2, 3, 9]);
  // \ を付けた記号は、\ だけを隠す
  assert.deepEqual(marks('\\*星\\*', ['hide']), [
    ['hide', '', '\\'],
    ['hide', '', '\\'],
  ]);
});

test('カーソルや選んだ範囲が触れていたら、記号を見せる', () => {
  const item = { reveal: [5, 10] };
  assert.equal(isRevealed(item, [{ from: 5, to: 5 }]), true);
  assert.equal(isRevealed(item, [{ from: 10, to: 10 }]), true);
  assert.equal(isRevealed(item, [{ from: 11, to: 11 }]), false);
  assert.equal(isRevealed(item, [{ from: 0, to: 20 }]), true);
  assert.equal(isRevealed(item, []), false);
  assert.equal(isRevealed({}, [{ from: 0, to: 0 }]), false);
});

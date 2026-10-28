import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, markdownToPlain, parseMarkdown, toggleTask } from '../extension/lib/markdown.js';
import { memoRichCopy } from '../extension/lib/copy-format.js';

test('見出し・段落・区切り線。段落の中の改行はそのまま改行にする', () => {
  assert.equal(markdownToHtml('# 会議\n\n1行目\n2行目\n---\n## 次 ##'), '<h1>会議</h1><p>1行目<br>2行目</p><hr><h2>次</h2>');
  // # の後ろが全角の空白でも見出し。空白が無ければ見出しにしない
  assert.equal(markdownToHtml('#　全角\n#タグ'), '<h1>全角</h1><p>#タグ</p>');
});

test('箇条書き・番号・チェックボックスと入れ子', () => {
  const md = '- 牛乳\n- [ ] 卵\n  - [x] L サイズ\n    10 個\n1. 一つ目\n2. 二つ目';
  assert.equal(
    markdownToHtml(md),
    '<ul><li>牛乳</li><li style="list-style-type: none">☐ 卵<ul><li style="list-style-type: none">☑ L サイズ<br>10 個</li></ul></li></ul>' +
      '<ol><li>一つ目</li><li>二つ目</li></ol>',
  );
  assert.equal(markdownToPlain(md), '・牛乳\n☐ 卵\n　☑ L サイズ\n　　10 個\n1. 一つ目\n2. 二つ目');
  // 番号は書いた数から振り直す。3. から始めたら start を付ける
  assert.equal(markdownToHtml('3. a\n3. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(markdownToPlain('1. a\n1. b'), '1. a\n2. b');
});

test('項目の間の空行ではリストを切らず、記号を外した文字には空行を残す', () => {
  assert.equal(markdownToHtml('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(markdownToPlain('- a\n\n- b\n\n\n本文'), '・a\n\n・b\n\n\n本文');
});

test('太字・斜体・取り消し線・コード。日本語のかっこや句読点の隣でも崩れない', () => {
  assert.equal(markdownToHtml('**「太字」**です'), '<p><strong>「太字」</strong>です</p>');
  assert.equal(markdownToHtml('これは*大事*。~~消す~~'), '<p>これは<em>大事</em>。<s>消す</s></p>');
  assert.equal(markdownToHtml('***両方***'), '<p><strong><em>両方</em></strong></p>');
  assert.match(markdownToHtml('`a*b*c` と ``x ` y``'), /<code[^>]*>a\*b\*c<\/code> と <code[^>]*>x ` y<\/code>/);
});

test('書式にしない記号：計算式・snake_case・空白に挟まれた記号・エスケープ', () => {
  for (const text of ['2*3*4', 'snake_case_name', 'a * b * c', '\\*そのまま\\*', '**閉じていない']) {
    assert.equal(markdownToPlain(text), text.replace(/\\(.)/g, '$1'), text);
  }
});

test('リンク。URL だけでもリンクにし、http・https・mailto 以外はリンクにしない', () => {
  assert.equal(markdownToHtml('[資料](https://example.com/a_(b))'), '<p><a href="https://example.com/a_(b)">資料</a></p>');
  assert.equal(markdownToHtml('見て https://example.jp/x。'), '<p>見て <a href="https://example.jp/x">https://example.jp/x</a>。</p>');
  assert.equal(markdownToHtml('[押す](javascript:alert(1))'), '<p>押す</p>');
  assert.equal(markdownToPlain('[資料](https://example.com) と <https://a.jp>'), '資料 https://example.com と https://a.jp');
  assert.equal(markdownToPlain('[連絡](mailto:a@example.com)'), '連絡 a@example.com');
});

test('書かれた HTML は文字として出す', () => {
  assert.equal(markdownToHtml('<img src=x onerror=alert(1)> & "a"'), '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;a&quot;</p>');
  assert.equal(markdownToHtml('```html\n<b>\n```'), '<pre style="font-family: ui-monospace, Menlo, Consolas, monospace"><code>&lt;b&gt;</code></pre>');
});

test('引用・コード・表', () => {
  assert.equal(markdownToHtml('> 引用\n> - 項目'), '<blockquote><p>引用</p><ul><li>項目</li></ul></blockquote>');
  assert.equal(markdownToPlain('```js\nconst a = 1;\n```'), 'const a = 1;');
  const table = '| 名前 | 数 |\n| :-- | --: |\n| a\\|b | 2 |';
  assert.equal(markdownToPlain(table), '名前\t数\na|b\t2');
  assert.match(markdownToHtml(table), /<th style="[^"]*text-align: left">名前<\/th>.*<td style="[^"]*text-align: right">2<\/td>/);
});

test('書式付きのコピー：印の場所に画像を入れ、印の無い画像は最後にまとめる', () => {
  const images = [
    { no: 1, src: 'data:image/png;base64,AAAA', width: 1280, height: 720 },
    { no: 2, src: 'data:image/png;base64,BBBB', width: 300, height: 200 },
  ];
  const { html, plain } = memoRichCopy('# 不具合\n[画像 1]\n[画像 3]', images);
  assert.ok(html.startsWith('<meta charset="utf-8"><h1>不具合</h1>'));
  assert.match(html, /<img src="data:image\/png;base64,AAAA" alt="画像 1" width="640" height="360"/);
  // 画像の無い印は文字のまま
  assert.match(html, /\[画像 3\]<\/p><p>添付画像<\/p><p><img src="data:image\/png;base64,BBBB" alt="画像 2" width="300" height="200"/);
  assert.equal(plain, '不具合\n[画像 1]\n[画像 3]');
});

test('チェックボックス：項目は本文の何行目かを持ち、その行の [ ] と [x] を入れ替えられる', () => {
  const text = '# 買い物\n\n- [ ] 牛乳\n  - [x] 低脂肪\n> 1. [ ] 引用の中\n- ふつうの項目';
  const lines = [];
  const walk = (blocks) => {
    for (const block of blocks) {
      if (block.type === 'quote') walk(block.blocks);
      const items = (list) => list.items.forEach((item) => (lines.push([item.line, item.task]), item.lists.forEach(items)));
      if (block.type === 'list') items(block);
    }
  };
  walk(parseMarkdown(text));
  assert.deepEqual(lines, [[2, false], [3, true], [4, false], [5, null]]);
  assert.equal(toggleTask(text, 2).split('\n')[2], '- [x] 牛乳');
  assert.equal(toggleTask(text, 3).split('\n')[3], '  - [ ] 低脂肪');
  assert.equal(toggleTask(text, 4).split('\n')[4], '> 1. [x] 引用の中');
  // チェックボックスの無い行は書き換えない
  assert.equal(toggleTask(text, 5), null);
  assert.equal(toggleTask(text, 0), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportText, parseBackupText } from '../extension/lib/backup-format.js';
import { extractLinks } from '../extension/lib/links.js';
import { splitText } from '../extension/lib/chrome-sync.js';
import { copyImagePath, imageMark, memoCopyText } from '../extension/lib/copy-format.js';

test('このアプリの書き出しは、見出しの番号順に取り込める', () => {
  const text = 'memosync-export 1\n\n===== メモ 2 =====\n2番目\n===== メモ 1 =====\n1行目\n2行目\n===== メモ 3 =====\n\n';
  assert.deepEqual(parseBackupText(text), [
    { number: 1, text: '1行目\n2行目' },
    { number: 2, text: '2番目' },
    { number: 3, text: '' },
  ]);
});

test('本文に --- や見出しに似た行があっても区切りと間違えない', () => {
  const text = 'memosync-export 1\n\n===== メモ 1 =====\n上\n---\n===== 見出し =====\n下\n===== メモ 2 =====\nb\n';
  assert.deepEqual(parseBackupText(text).map((item) => item.text), ['上\n---\n===== 見出し =====\n下', 'b']);
});

test('Windows の改行と BOM が付いていても読める', () => {
  const text = '\uFEFFmemosync-export 1\r\n\r\n===== メモ 1 =====\r\nこんにちは\r\n';
  assert.deepEqual(parseBackupText(text), [{ number: 1, text: 'こんにちは' }]);
});

test('このアプリの形式でないテキストは、ほかのアプリのバックアップも含めて 1 件のメモになる', () => {
  assert.deepEqual(parseBackupText('memo-1\n\n本文\n\n---\n\n'), [{ number: 1, text: 'memo-1\n\n本文\n\n---' }]);
  assert.deepEqual(parseBackupText('ただのテキスト\n'), [{ number: 1, text: 'ただのテキスト' }]);
  assert.deepEqual(parseBackupText('  \n'), []);
});

test('書き出したものを取り込むと同じ内容に戻る', () => {
  const doc = {
    order: ['aaaa', 'bbbb', 'cccc'],
    orderUpdatedAt: 1,
    memos: {
      aaaa: { text: 'one\n\ntwo', updatedAt: 1 },
      bbbb: { text: '', updatedAt: 1, deleted: true },
      cccc: { text: '三\n\n', updatedAt: 1 },
    },
  };
  assert.deepEqual(parseBackupText(exportText(doc)).map((item) => item.text), ['one\n\ntwo', '三\n\n']);
});

test('リンクは http と https だけを取り出す', () => {
  const text = 'あ https://example.com/a?b=1。と(https://ja.wikipedia.org/wiki/Foo_(bar)) javascript:alert(1) http://x.test/、ftp://y';
  assert.deepEqual(extractLinks(text), [
    'https://example.com/a?b=1',
    'https://ja.wikipedia.org/wiki/Foo_(bar)',
    'http://x.test/',
  ]);
});

test('本文を分けても元に戻せ、絵文字の途中で切らない', () => {
  const text = 'あいうえお😀\n"引用"\\'.repeat(2_000);
  const chunks = splitText(text, 500);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).length <= 500);
    assert.ok(!/[\ud800-\udbff]$/.test(chunk));
  }
});

test('コピーの文章：[画像 1] の印を Markdown の画像に置き換え、印の無い画像は最後に書き足す', () => {
  assert.equal(memoCopyText('直してほしい点\n', []), '直してほしい点\n');
  const one = '/Users/me/Downloads/memosync/memo-abcd/image-1.webp';
  const three = '/Users/me/Downloads/memosync/memo-abcd/image-3.png';
  const files = [{ no: 1, file: one }, { no: 3, file: three }];
  // 印のある画像は、その場所に書く。画像の無い印（消した画像）はそのまま
  assert.equal(
    memoCopyText('ボタンがずれる\n[画像 1]\n文字が切れる\n[画像3]\n[画像 2]\n', files),
    `ボタンがずれる\n![画像 1](${one})\n文字が切れる\n![画像 3](${three})\n[画像 2]\n`,
  );
  // 印を消した画像は、最後にまとめる
  assert.equal(
    memoCopyText('直してほしい点\n[画像 1]\n\n', files),
    `直してほしい点\n![画像 1](${one})\n\n添付画像のファイル:\n- ![画像 3](${three})\n`,
  );
  assert.equal(memoCopyText('', files.slice(0, 1)), `添付画像のファイル:\n- ![画像 1](${one})\n`);
  // 空白のある場所は <> で囲む
  const spaced = 'C:\\Users\\Taro Yamada\\Downloads\\memosync\\memo-abcd\\image-1.png';
  assert.equal(memoCopyText('[画像 1]', [{ no: 1, file: spaced }]), `![画像 1](<${spaced}>)`);
  assert.equal(imageMark(2), '[画像 2]');
  assert.equal(copyImagePath('abcd', 1, 'image/webp'), 'memosync/memo-abcd/image-1.webp');
  assert.equal(copyImagePath('abcd', 3, 'image/jpeg'), 'memosync/memo-abcd/image-3.jpg');
});

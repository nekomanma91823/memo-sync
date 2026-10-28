// 画面に出す文（失敗の説明・同期の状態・名前）の約束ごと

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeError, errorText } from '../extension/lib/errors.js';
import { formatWhen } from '../extension/lib/time-format.js';
import { describeProblem, describeStatus } from '../extension/ui/common.js';

const ext = join(import.meta.dirname, '..', 'extension');

test('英語の失敗は日本語にし、元の文は「詳しく」用に残す', () => {
  assert.deepEqual(describeError(new Error('The user did not approve access.')), {
    message: 'Google へのログインが完了しませんでした。もう一度「接続する」を押してください。',
    detail: 'The user did not approve access.',
  });
  assert.match(describeError('FILE_NO_SPACE').message, /空きが足りない/);
  assert.match(describeError(new Error('Document is not focused.')).message, /もう一度/);
  assert.match(describeError(new Error('QUOTA_BYTES quota exceeded')).message, /100KB/);
  // 日本語の文はそのまま
  assert.deepEqual(describeError(new Error('メモが見つかりません')), { message: 'メモが見つかりません', detail: '' });
  // 1 行で出すとき：知らない英語は画面に出さず、どうすればよいかを書く
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(errorText(new Error('Something odd')), '処理に失敗しました。もう一度試してください。');
    assert.equal(errorText(new Error('Something odd'), '保存できませんでした。'), '保存できませんでした。もう一度試してください。');
  } finally {
    console.warn = warn;
  }
  // 何ができなかったかの一文を前に付ける。同じ一文で始まる説明には重ねない
  assert.equal(errorText(new Error('Failed to fetch'), '保存できませんでした。'), '保存できませんでした。ネットワークにつながっていません。つながると自動で再開します。');
  assert.equal(errorText(new Error('Document is not focused.'), 'コピーできませんでした。'), 'コピーできませんでした。メモの画面を一度押してから、もう一度お試しください。');
});

test('同期の時刻は、今日でなければ日付も付ける', () => {
  const now = new Date(2026, 9, 19, 12, 0).getTime();
  assert.equal(formatWhen(new Date(2026, 9, 19, 9, 5).getTime(), now), '09:05');
  assert.equal(formatWhen(new Date(2026, 9, 18, 21, 4).getTime(), now), '10/18 21:04');
});

test('Chrome 同期は「保存済み」、失敗したら次にすることと最後に同期できた時刻を出す', () => {
  const at = Date.now();
  assert.match(describeStatus({ state: 'ok', mode: 'chrome', at }).text, /^保存済み /);
  assert.match(describeStatus({ state: 'ok', mode: 'chrome', at }).title, /Chrome の同期がオンなら/);
  assert.match(describeStatus({ state: 'ok', mode: 'drive', at }).text, /^同期済み /);
  assert.equal(describeStatus({ state: 'error', mode: 'chrome', kind: 'quota', message: '容量' }).text, '容量オーバー');
  assert.equal(describeProblem({ state: 'ok', mode: 'drive', at }), null);
  assert.equal(describeProblem({ state: 'syncing', mode: 'drive' }), null);
  const auth = describeProblem({ state: 'auth', mode: 'drive', message: '接続が切れました。', lastOkAt: at });
  assert.equal(auth.action, 'connect');
  assert.match(auth.text, /この PC には保存されています/);
  assert.match(auth.text, /最後に同期できたのは/);
  assert.equal(describeProblem({ state: 'error', mode: 'chrome', kind: 'quota', message: 'x' }).action, 'settings');
  assert.equal(describeProblem({ state: 'error', mode: 'drive', kind: 'remote', message: 'x' }).action, 'retry');
});

test('名前は _locales の 1 か所で決め、manifest はそれを使う', () => {
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  const messages = JSON.parse(readFileSync(join(ext, '_locales', manifest.default_locale, 'messages.json'), 'utf8'));
  assert.equal(manifest.name, '__MSG_appName__');
  assert.equal(manifest.action.default_title, '__MSG_appName__');
  assert.ok(messages.appName.message);
  assert.ok(messages.appDescription.message.length <= 132); // ストアの説明の上限
  // Mac では Option+Shift が記号の入力に使われるので、Control を使う
  assert.match(manifest.commands._execute_action.suggested_key.mac, /^MacCtrl\+/);
});

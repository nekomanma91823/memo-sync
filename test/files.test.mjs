// 拡張機能のファイルどうしの約束ごとを確かめる

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ext = join(import.meta.dirname, '..', 'extension');
const read = (path) => readFileSync(join(ext, path), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('ポップアップとサイドパネルの HTML は data-view 以外同じ', () => {
  const normalize = (html) => html.replace(/data-view="\w+"/, '').replace(/<!--.*?-->/, '');
  assert.equal(normalize(read('ui/popup.html')), normalize(read('ui/panel.html')));
});

test('manifest が参照するファイルがすべてある', () => {
  const paths = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.side_panel.default_path,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const path of paths) assert.ok(existsSync(join(ext, path)), path);
});

test('権限は最小限で、ドライブはアプリ専用フォルダの権限だけ', () => {
  // contextMenus（右クリックで送る）はインストール時の警告が出ない
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'alarms', 'contextMenus', 'identity', 'sidePanel', 'storage', 'unlimitedStorage']);
  // tabs はサイドパネルの「URL」、downloads は画像付きの「コピー」で、使うときにだけ許可を求める
  assert.deepEqual(manifest.optional_permissions, ['tabs', 'downloads']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  // キー操作で開く（権限はいらない）
  assert.ok(manifest.commands._execute_action.suggested_key.default);
  assert.deepEqual(manifest.oauth2.scopes, ['https://www.googleapis.com/auth/drive.appdata']);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self';/);
  // 画像は端末内の本体から作った blob: の URL でだけ表示する（外部の画像は読み込まない）
  assert.match(manifest.content_security_policy.extension_pages, /img-src 'self' blob:;/);
});

test('画面のスクリプトはメモの文字を HTML として組み立てない', () => {
  const scripts = ['editor', 'live-editor', 'preview', 'images', 'annotate', 'search', 'memo-copy', 'sensitive-bar', 'notice', 'menu', 'inline-edit', 'export', 'options', 'options-trash', 'options-ui', 'options-backups', 'common', 'theme'];
  for (const path of scripts.map((name) => `ui/${name}.js`)) {
    const code = read(path);
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, path);
  }
  for (const path of ['ui/popup.html', 'ui/options.html']) {
    assert.doesNotMatch(read(path), /<script(?![^>]*src=)|\sstyle=|\son\w+=/i, path);
  }
});

test('見た目の設定は、どの画面でもスタイルより先に当てる', () => {
  for (const path of ['ui/popup.html', 'ui/panel.html', 'ui/options.html']) {
    const html = read(path);
    assert.match(html, /<script src="theme\.js"><\/script>/, path);
    assert.ok(html.indexOf('theme.js') < html.indexOf('<link rel="stylesheet"'), path);
  }
  // light-dark() は Chrome 123 から
  assert.ok(Number(manifest.minimum_chrome_version) >= 123);
});

test('CodeMirror のまとめは、package.json の版から作り、見た目をページに書かない形にしてある', () => {
  const pkg = JSON.parse(readFileSync(join(ext, '..', 'package.json'), 'utf8'));
  const bundle = read('vendor/codemirror.js');
  const license = read('vendor/codemirror.LICENSE.txt');
  // 作り直し忘れに気づくため、ライセンスの文に書いた版と package.json の版を比べる
  for (const name of ['@codemirror/state', '@codemirror/view', '@codemirror/commands']) {
    assert.ok(license.includes(`${name}@${pkg.devDependencies[name]} (MIT)`), name);
  }
  // 拡張機能の画面は <style> を読み込まないので、スクリプトから作るスタイルシートで入れる（tools/build-vendor.mjs）
  assert.ok(bundle.includes('if (root.adoptedStyleSheets && win.CSSStyleSheet) {'));
  assert.ok(!bundle.includes('!root.head && root.adoptedStyleSheets'));
  // 外から読み込んだり、文字をコードとして動かしたりしない
  assert.doesNotMatch(bundle, /\beval\(|new Function\(|import\(\s*['"`]https?:/);
});

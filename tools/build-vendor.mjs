// 書式を付けたまま書く入力欄に使う CodeMirror を、extension/vendor/ に 1 つのファイルにまとめる。
//   npm run vendor
//
// - 拡張機能は外からコードを読み込めないので、まとめたファイルをリポジトリに入れる
// - ストアの審査で読めるように、縮めずに書き出す
// - まとめた部品のライセンスを、codemirror.LICENSE.txt に並べる
// - 見た目を <style> 要素でなく、スクリプトから作るスタイルシートで入れるように、style-mod を 1 か所だけ書き換える。
//   拡張機能の画面は、ページの中に書いたスタイルを読み込まない決まりにしているため（manifest の content_security_policy）

import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'vendor', 'codemirror.js');

// style-mod は、影の DOM のときだけスクリプトから作るスタイルシートを使う。ページ全体でも使うようにする
const STYLE_MOD_FROM = 'if (!root.head && root.adoptedStyleSheets && win.CSSStyleSheet) {';
const STYLE_MOD_TO = 'if (root.adoptedStyleSheets && win.CSSStyleSheet) {';
const adoptedSheets = {
  name: 'adopted-sheets',
  setup(b) {
    b.onLoad({ filter: /node_modules[\\/]style-mod[\\/].*\.js$/ }, (args) => {
      const code = readFileSync(args.path, 'utf8');
      if (!code.includes(STYLE_MOD_FROM)) throw new Error('style-mod の書き換える場所が見つかりません。版が変わったら確かめ直してください');
      return { contents: code.replace(STYLE_MOD_FROM, STYLE_MOD_TO), loader: 'js' };
    });
  },
};

const result = await build({
  entryPoints: [join(root, 'tools', 'codemirror-entry.js')],
  outfile: out,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: false,
  legalComments: 'inline',
  metafile: true,
  banner: { js: '// CodeMirror をまとめたファイル。tools/build-vendor.mjs が作る。直接書き換えない。ライセンスは codemirror.LICENSE.txt' },
  logLevel: 'warning',
  plugins: [adoptedSheets],
});

// まとめに入った部品ごとに、package.json とライセンスの文を集める
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (!m || packages.has(m[1])) continue;
  const dir = join(root, 'node_modules', m[1]);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].map((name) => join(dir, name)).find(existsSync);
  if (!file) throw new Error(`${m[1]} のライセンスの文が見つかりません`);
  packages.set(m[1], { version: pkg.version, license: pkg.license, text: readFileSync(file, 'utf8').trim() });
}
const notice = [...packages]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, { version, license, text }]) => `${name}@${version} (${license})\n\n${text}`)
  .join(`\n\n${'-'.repeat(72)}\n\n`);
writeFileSync(join(root, 'extension', 'vendor', 'codemirror.LICENSE.txt'), `${notice}\n`);
console.log(`作成しました: ${out}。まとめた部品は ${packages.size} 個です`);

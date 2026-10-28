// Chrome ウェブストアに提出する zip を dist/ に作る。
//   node tools/pack.mjs
//
// - manifest の "key" は外す（ストアに出すときは、ストアが ID を決めるため）
// - OAuth クライアント ID が未設定なら警告する（Google ドライブ同期が使えないまま出さないため）

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const name = `memo-sync-${manifest.version}`;
const build = join(root, 'dist', name);
const zip = join(root, 'dist', `${name}.zip`);

rmSync(build, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(build, { recursive: true });
cpSync(source, build, { recursive: true, filter: (path) => !path.endsWith('.DS_Store') });

delete manifest.key;
writeFileSync(join(build, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: build });
rmSync(build, { recursive: true });

if (!manifest.oauth2?.client_id || manifest.oauth2.client_id.startsWith('YOUR_')) {
  console.warn('警告: manifest.json の oauth2.client_id が未設定です。Google ドライブ同期は使えません。');
}
console.log(`作成しました: ${zip}`);
if (!existsSync(zip)) process.exit(1);

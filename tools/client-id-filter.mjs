// manifest.json の OAuth クライアント ID を、Git に入れるときだけ YOUR_CLIENT_ID に置き換える。
// 公開するリポジトリに自分のクライアント ID を載せないため。手元のファイルには本物の ID が残るので、
// 開発中も Google ドライブ同期を試せる。Git の clean と smudge の仕組みで動く。
//   node tools/client-id-filter.mjs clean   … Git に入れるとき。ID を YOUR_CLIENT_ID.apps.googleusercontent.com にする
//   node tools/client-id-filter.mjs smudge  … Git から取り出すとき。private/oauth-client-id.txt があれば、その ID に戻す
// 使い始めるときは、このリポジトリで 1 回だけ npm run setup を実行する。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
const CLIENT_ID_RE = /("client_id"\s*:\s*")[^"]*(")/;
const ID_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'private', 'oauth-client-id.txt');

export function clean(text) {
  return text.replace(CLIENT_ID_RE, `$1${PLACEHOLDER}$2`);
}

export function smudge(text, id) {
  return id ? text.replace(CLIENT_ID_RE, `$1${id}$2`) : text;
}

function savedId() {
  if (!existsSync(ID_FILE)) return '';
  const id = readFileSync(ID_FILE, 'utf8').trim();
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) ? id : '';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const input = readFileSync(0, 'utf8');
  if (mode === 'clean') process.stdout.write(clean(input));
  else if (mode === 'smudge') process.stdout.write(smudge(input, savedId()));
  else {
    process.stdout.write(input);
    process.exitCode = 1;
  }
}

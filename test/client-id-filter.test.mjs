import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACEHOLDER, clean, smudge } from '../tools/client-id-filter.mjs';

const manifest = (id) => `{\n  "oauth2": {\n    "client_id": "${id}",\n    "scopes": []\n  }\n}\n`;

test('Git に入れるときはクライアント ID を YOUR_CLIENT_ID にし、取り出すときは手元の ID に戻す', () => {
  const real = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
  assert.equal(clean(manifest(real)), manifest(PLACEHOLDER));
  assert.equal(smudge(manifest(PLACEHOLDER), real), manifest(real));
  // 手元に ID が無ければ、そのまま
  assert.equal(smudge(manifest(PLACEHOLDER), ''), manifest(PLACEHOLDER));
  // 本物の manifest でも、ID の行だけが変わる
  const text = readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8');
  const cleaned = clean(text);
  assert.ok(cleaned.includes(`"client_id": "${PLACEHOLDER}"`));
  assert.equal(cleaned.split('\n').length, text.split('\n').length);
});

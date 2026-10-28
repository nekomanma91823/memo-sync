// テスト用の chrome.storage と Google ドライブの代わり

import { Engine } from '../extension/lib/engine.js';
import { createChromeSyncBackend } from '../extension/lib/chrome-sync.js';
import { createDriveBackend } from '../extension/lib/drive-sync.js';
import { AuthError } from '../extension/lib/errors.js';
import { readLocalDoc } from '../extension/lib/local-doc.js';
import { visibleIds } from '../extension/lib/model.js';

const encoder = new TextEncoder();
const bytes = (s) => encoder.encode(s).length;

// chrome.storage の StorageArea と同じ呼び方ができるもの。容量の上限も再現する
export class FakeArea {
  constructor({ quotaBytes = Infinity, perItemBytes = Infinity, maxItems = Infinity } = {}) {
    this.data = new Map();
    this.limits = { quotaBytes, perItemBytes, maxItems };
    this.setCalls = 0;
    this.listeners = [];
  }

  async get(keys) {
    const out = {};
    if (keys == null) {
      for (const [key, value] of this.data) out[key] = structuredClone(value);
      return out;
    }
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      for (const key of keys) if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
      return out;
    }
    for (const [key, fallback] of Object.entries(keys)) {
      out[key] = this.data.has(key) ? structuredClone(this.data.get(key)) : fallback;
    }
    return out;
  }

  async set(items) {
    const next = new Map(this.data);
    for (const [key, value] of Object.entries(items)) {
      if (bytes(key) + bytes(JSON.stringify(value)) > this.limits.perItemBytes) {
        throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      }
      next.set(key, structuredClone(value));
    }
    let total = 0;
    for (const [key, value] of next) total += bytes(key) + bytes(JSON.stringify(value));
    if (total > this.limits.quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
    if (next.size > this.limits.maxItems) throw new Error('MAX_ITEMS quota exceeded');
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: this.data.get(key), newValue: structuredClone(value) };
    }
    this.data = next;
    this.setCalls++;
    this.emit(changes);
  }

  async getBytesInUse(keys) {
    const list = keys == null ? [...this.data.keys()] : typeof keys === 'string' ? [keys] : keys;
    let total = 0;
    for (const key of list) if (this.data.has(key)) total += bytes(key) + bytes(JSON.stringify(this.data.get(key)));
    return total;
  }

  async remove(keys) {
    const changes = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!this.data.has(key)) continue;
      changes[key] = { oldValue: this.data.get(key) };
      this.data.delete(key);
    }
    this.emit(changes);
  }

  emit(changes) {
    if (Object.keys(changes).length) for (const fn of this.listeners) fn(changes);
  }
}

export function chromeSyncArea() {
  return new FakeArea({ quotaBytes: 102_400, perItemBytes: 8_192, maxItems: 512 });
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// バイト列と、1 バイト = 1 文字の文字列を行き来する（multipart の本文をバイトのまま切り分けるため）
const toBinary = (data) => {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return s;
};
const fromBinary = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
// Drive と同じく、ファイルの大きさはバイト数を文字で返す
const sizeOf = (content) => (typeof content === 'string' ? bytes(content) : content.byteLength);

// Drive API のうち、このアプリが使う部分だけを再現する。
// content は JSON のファイルなら文字、画像ならバイト列
export class FakeDrive {
  constructor({ now = () => Date.now() } = {}) {
    this.files = new Map();
    this.created = 0;
    this.now = now;
    this.validTokens = new Set(['token-1']);
    this.requests = [];
    this.fetch = this.fetch.bind(this);
  }

  addFile(content, { name = 'memo-sync.json', mimeType = 'application/json', createdAt = this.now() } = {}) {
    const id = `file${++this.created}`;
    this.files.set(id, { id, name, mimeType, seq: this.created, createdTime: new Date(createdAt).toISOString(), content });
    return id;
  }

  filesNamed(name) {
    return [...this.files.values()].filter((file) => file.name === name);
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}`);
    const token = (init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    if (!this.validTokens.has(token)) return json({ error: { errors: [{ reason: 'authError' }] } }, 401);

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      if (url.searchParams.get('spaces') !== 'appDataFolder') return json({ error: {} }, 400);
      const files = [...this.files.values()]
        .sort((a, b) => a.seq - b.seq)
        .map(({ id, name, createdTime, content }) => ({ id, name, createdTime, size: String(sizeOf(content)) }));
      return json({ files });
    }
    if (url.pathname === '/drive/v3/about' && method === 'GET') {
      return json({ storageQuota: { limit: '16106127360', usage: '5368709120' } });
    }
    const file = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (file && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const found = this.files.get(file[1]);
      return found ? new Response(found.content) : json({ error: {} }, 404);
    }
    if (file && method === 'DELETE') {
      if (!this.files.delete(file[1])) return json({ error: {} }, 404);
      return new Response(null, { status: 204 });
    }
    const upload = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (upload && method === 'PATCH') {
      const found = this.files.get(upload[1]);
      if (!found) return json({ error: {} }, 404);
      found.content = init.body;
      return json({ id: found.id });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = init.headers['Content-Type'].match(/boundary=(.+)$/)[1];
      const body = toBinary(new Uint8Array(await new Response(init.body).arrayBuffer()));
      const parts = body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      const decode = (part) => new TextDecoder().decode(fromBinary(part));
      const metadata = JSON.parse(decode(parts[0]));
      if (metadata.parents?.[0] !== 'appDataFolder') return json({ error: {} }, 400);
      const content = metadata.mimeType === 'application/json' ? decode(parts[1]) : fromBinary(parts[1]);
      return json({ id: this.addFile(content, { name: metadata.name, mimeType: metadata.mimeType }) });
    }
    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 500);
  }
}

// 1 台の端末。sync と drive は複数の端末で共有して使う
export function createDevice({ sync = chromeSyncArea(), drive = new FakeDrive(), clock } = {}) {
  const local = new FakeArea();
  const auth = { token: 'token-1' };
  const engine = new Engine({
    local,
    autoSync: false,
    now: clock ?? (() => Date.now()),
    backends: {
      chrome: createChromeSyncBackend(sync),
      drive: createDriveBackend({
        fetch: drive.fetch,
        getToken: async () => {
          if (!auth.token) throw new AuthError('Google ドライブに接続されていません。');
          return auth.token;
        },
        dropToken: async () => {
          auth.token = auth.refreshTo ?? null;
        },
      }),
    },
  });
  return { engine, local, auth, sync, drive };
}

// 端末をまたいで時刻が必ず進む時計
export function createClock(start = 1_700_000_000_000) {
  let t = start;
  const clock = () => (t += 1);
  clock.advance = (ms) => {
    t += ms;
  };
  return clock;
}

export async function visibleTexts(device) {
  const doc = await readLocalDoc(device.local);
  return visibleIds(doc).map((id) => doc.memos[id].text);
}

export async function visible(device) {
  const doc = await readLocalDoc(device.local);
  return { doc, ids: visibleIds(doc) };
}

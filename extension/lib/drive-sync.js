// 同期方式②：Google ドライブ
//
// ドライブの「アプリ専用の隠しフォルダ」（appDataFolder）に memo-sync.json を 1 つ置く。
// 権限は drive.appdata だけなので、利用者のほかのファイルは見えない。
// 2 台が同時に最初のファイルを作ると重複するので、読むときは全部を統合し、
// 書くときは一番古いファイルに書いて残りを消す。
//
// 貼った画像の本体は、同じフォルダに img-<画像の ID> という名前で 1 枚ずつ置く
// （記録は memo-sync.json の images）。他の端末が記録を見て本体を探しに来ても見つかるよう、
// 本体を先に送ってから記録を書く。記録の無い本体は、送っている途中かもしれないので、
// しばらく経ってから消す。

import { MAX_IMAGE_BYTES, docEquals, mergeDocs, sanitizeDoc } from './model.js';
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { AuthError, QuotaError, RemoteError } from './errors.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 90_000;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
export const DRIVE_FILE_NAME = 'memo-sync.json';
const IMAGE_FILE_RE = /^img-([a-z0-9]{4,32})$/;

export function imageFileName(id) {
  return `img-${id}`;
}

async function toError(response) {
  let reason = '';
  try {
    const data = await response.json();
    reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? '';
  } catch {
    // 本文が JSON でなければ、状態コードだけで判断する
  }
  if (response.status === 401 || /insufficient(Permissions|Scopes)|authError/i.test(reason)) {
    return new AuthError('Google ドライブへの接続が切れました。接続し直してください。');
  }
  if (/storageQuotaExceeded|quotaExceeded/i.test(reason)) {
    return new QuotaError('Google アカウントの容量がいっぱいのため、ドライブに保存できません。Google ドライブ・Gmail・Google フォトのいらないものを消すか、容量を増やしてください。');
  }
  if (response.status === 429 || /rateLimitExceeded/i.test(reason)) {
    return new RemoteError('Google ドライブが混み合っています。しばらくすると自動で再開します。');
  }
  return new RemoteError(`Google ドライブでエラーが起きました。コード ${response.status}${reason ? ` ${reason}` : ''}`);
}

// getToken() はアクセス用のトークンを返す（無ければ AuthError）。
// dropToken(token) は期限切れのトークンを Chrome の保管から外す。
export function createDriveBackend({ fetch: fetchFn, getToken, dropToken }) {
  // allow404: 他の端末が先に消したファイルを消すときなど、見つからなくてもよい
  async function call(base, path, { method = 'GET', query = {}, headers = {}, body, timeout = TIMEOUT_MS, allow404 = false } = {}) {
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      let response;
      try {
        response = await fetchFn(url, {
          method,
          headers: { ...headers, Authorization: `Bearer ${token}` },
          body,
          signal: AbortSignal.timeout(timeout),
        });
      } catch {
        throw new RemoteError('Google ドライブにつながりませんでした。ネットワークを確認してください。');
      }
      if (response.status === 401 && attempt === 0) {
        await dropToken(token);
        continue;
      }
      if (response.status === 404 && allow404) return response;
      if (!response.ok) throw await toError(response);
      return response;
    }
  }

  // このアプリ専用フォルダのファイルを全部（メモの記録と画像の本体）
  async function listFiles() {
    const files = [];
    let pageToken = null;
    do {
      const query = {
        spaces: 'appDataFolder',
        q: 'trashed = false',
        fields: 'nextPageToken,files(id,name,createdTime,size)',
        orderBy: 'createdTime',
        pageSize: '1000',
      };
      if (pageToken) query.pageToken = pageToken;
      const data = await (await call(API, '/files', { query })).json();
      for (const file of Array.isArray(data?.files) ? data.files : []) {
        if (typeof file?.id === 'string' && typeof file.name === 'string') files.push(file);
      }
      pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : null;
    } while (pageToken);
    return files;
  }

  // parents を付けて新しいファイルを作る。content は文字かバイト列
  async function createFile(name, mimeType, content) {
    const boundary = `memo-sync-${crypto.randomUUID()}`;
    const metadata = { name, parents: ['appDataFolder'], mimeType };
    const head = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType === 'application/json' ? 'application/json; charset=UTF-8' : mimeType}`,
      '',
      '',
    ].join('\r\n');
    await call(UPLOAD_API, '/files', {
      method: 'POST',
      query: { uploadType: 'multipart', fields: 'id' },
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: new Blob([head, content, `\r\n--${boundary}--\r\n`]),
      timeout: MEDIA_TIMEOUT_MS,
    });
  }

  function deleteFile(id) {
    return call(API, `/files/${encodeURIComponent(id)}`, { method: 'DELETE', allow404: true });
  }

  async function writeDoc(doc, remote) {
    const files = remote.files ?? [];
    if (remote.doc && files.length === 1 && docEquals(remote.doc, doc)) return;
    const body = JSON.stringify({
      app: 'memo-sync',
      version: 1,
      order: doc.order,
      orderUpdatedAt: doc.orderUpdatedAt,
      memos: doc.memos,
      images: doc.images,
    });
    if (!files.length) {
      await createFile(DRIVE_FILE_NAME, 'application/json', body);
      return;
    }
    await call(UPLOAD_API, `/files/${encodeURIComponent(files[0].id)}`, {
      method: 'PATCH',
      query: { uploadType: 'media' },
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body,
    });
    for (const extra of files.slice(1)) await deleteFile(extra.id);
  }

  async function download(id) {
    const response = await call(API, `/files/${encodeURIComponent(id)}`, { query: { alt: 'media' } });
    let raw = null;
    try {
      raw = JSON.parse(await response.text());
    } catch {
      // 下で読めなかった扱いにする
    }
    const doc = sanitizeDoc(raw);
    // 読めないファイルを手元の内容で上書きすると、中身を取り戻せなくなるので止める
    if (!doc) throw new RemoteError('Google ドライブの保存データを読み取れませんでした。上書きを防ぐため同期を止めています。');
    return doc;
  }

  return {
    async pull() {
      const all = await listFiles();
      const files = all.filter((file) => file.name === DRIVE_FILE_NAME);
      // 画像の ID → 本体のファイル（ふつうは 1 つ。送り直しで重なることがある）
      const blobs = new Map();
      for (const file of all) {
        const match = file.name.match(IMAGE_FILE_RE);
        if (match) blobs.set(match[1], [...(blobs.get(match[1]) ?? []), file]);
      }
      let doc = null;
      for (const file of files) {
        const fileDoc = await download(file.id);
        doc = doc ? mergeDocs(doc, fileDoc).doc : fileDoc;
      }
      return { doc, files, blobs };
    },

    // loadImage(id) は端末内にある画像の本体 { type, data } を返す（無ければ null）
    async push(doc, remote, dropped, { loadImage = async () => null, now = Date.now() } = {}) {
      const blobs = remote.blobs ?? new Map();
      for (const [id, image] of Object.entries(doc.images)) {
        if (image.deleted || blobs.has(id)) continue;
        const blob = await loadImage(id);
        // 本体がこの PC に無いのは、他の端末で貼られてまだ届いていない画像
        if (blob) await createFile(imageFileName(id), image.type, base64ToBytes(blob.data));
      }

      await writeDoc(doc, remote);

      for (const [id, list] of blobs) {
        const image = doc.images[id];
        let unused;
        if (image && !image.deleted) unused = list.slice(1);
        else if (image) unused = list;
        else unused = list.filter((file) => now - Date.parse(file.createdTime) > ORPHAN_GRACE_MS);
        for (const file of unused) await deleteFile(file.id);
      }
    },

    // このアプリ専用フォルダの使用量と、ドライブ全体の使用量・上限（上限の無い契約では limit が null）
    async usage() {
      const files = await listFiles();
      const size = (file) => Number(file.size) || 0;
      const images = files.filter((file) => IMAGE_FILE_RE.test(file.name));
      const about = await (await call(API, '/about', { query: { fields: 'storageQuota(limit,usage)' } })).json();
      const quota = about?.storageQuota ?? {};
      const number = (value) => (Number.isFinite(Number(value)) && value !== undefined && value !== null ? Number(value) : null);
      return {
        appBytes: files.reduce((sum, file) => sum + size(file), 0),
        imageBytes: images.reduce((sum, file) => sum + size(file), 0),
        imageFiles: images.length,
        driveUsage: number(quota.usage),
        driveLimit: number(quota.limit),
      };
    },

    async downloadImage(remote, id, image) {
      const [file] = remote.blobs?.get(id) ?? [];
      if (!file) return null;
      const response = await call(API, `/files/${encodeURIComponent(file.id)}`, {
        query: { alt: 'media' },
        timeout: MEDIA_TIMEOUT_MS,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
      return { type: image.type, data: bytesToBase64(bytes) };
    },
  };
}

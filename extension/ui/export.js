// すべてのメモの書き出し（設定画面の「全部を書き出す」）。
// 画像が無ければ今までどおりの .txt、画像があれば memos.txt と画像をまとめた .zip にする。
// どちらも設定画面の「取り込み」でそのまま戻せる。

import { memoImageIds, visibleIds } from '../lib/model.js';
import { imageKey, readLocalDoc } from '../lib/local-doc.js';
import { backupFileName, exportFiles, exportText } from '../lib/backup-format.js';
import { createZip } from '../lib/zip.js';
import { downloadBlob, downloadText } from './common.js';

// 返り値: { images: 入れた画像の数, missing: この PC に本体が無くて入れられなかった数 }
export async function exportAll() {
  const doc = await readLocalDoc(chrome.storage.local);
  const ids = visibleIds(doc).flatMap((memoId) => memoImageIds(doc, memoId));
  if (!ids.length) {
    downloadText(backupFileName(), exportText(doc));
    return { images: 0, missing: 0 };
  }
  const values = await chrome.storage.local.get(ids.map(imageKey));
  const blobs = Object.fromEntries(ids.filter((id) => values[imageKey(id)]).map((id) => [id, values[imageKey(id)]]));
  const { files, images, missing } = exportFiles(doc, blobs);
  downloadBlob(backupFileName(new Date(), 'zip'), new Blob([createZip(files)], { type: 'application/zip' }));
  return { images, missing };
}

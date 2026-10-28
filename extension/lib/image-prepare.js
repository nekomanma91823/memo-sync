// 貼る前に画像を整える。メモの画面（ポップアップ・サイドパネル）と設定画面（取り込み）で使う。

import { IMAGE_TYPES, MAX_IMAGE_BYTES } from './model.js';
import { bytesToBase64 } from './base64.js';

// 大きな画像は長い辺をここまで縮める（スクリーンショットの文字が読める大きさ）
const MAX_SIDE = 2560;
// これより大きい画像は WebP にして小さくする
const REENCODE_OVER_BYTES = 1_000_000;

// 大きすぎる画像を縮める。GIF は動きが消えるので縮めない。file は File か Blob
export async function prepareImage(file) {
  if (file.type === 'image/svg+xml') throw new Error('SVG の画像は貼れません');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('画像を読み取れませんでした');
  }
  try {
    const known = IMAGE_TYPES.includes(file.type);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    let blob = file;
    let { width, height } = bitmap;
    if (!known || (file.type !== 'image/gif' && (scale < 1 || file.size > REENCODE_OVER_BYTES))) {
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      const encoded = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
      if (!known || scale < 1 || encoded.size < file.size) {
        blob = encoded;
        width = w;
        height = h;
      }
    }
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`画像が大きすぎます。${MAX_IMAGE_BYTES / 1024 / 1024}MB までです`);
    return { type: blob.type, width, height, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
  } finally {
    bitmap.close();
  }
}

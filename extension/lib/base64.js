// 画像の本体は chrome.storage と拡張機能のメッセージで受け渡すため、base64 の文字にしておく

const CHUNK = 0x8000;
// 数 MB の文字にも使うので、繰り返しのグループを使わない（正規表現のスタックがあふれる）
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isBase64(text) {
  return typeof text === 'string' && text.length % 4 === 0 && BASE64_RE.test(text);
}

// 元のバイト数（文字のまま数える）
export function base64ByteLength(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

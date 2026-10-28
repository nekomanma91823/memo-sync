// 画面どうしで使い回す小さな部品

import { formatDateTime, formatWhen } from '../lib/time-format.js';

export const MODE_LABELS = { chrome: 'Chrome の同期機能', drive: 'Google ドライブ' };

// 拡張機能の名前（仮の名前なので、_locales/ja/messages.json の 1 か所で変えられるようにしている）
export const APP_NAME = globalThis.chrome?.i18n?.getMessage('appName') || 'メモシンク';

// data-app-name を付けた要素の文字と、画面の題に名前を入れる
export function applyAppName(root = document) {
  for (const node of root.querySelectorAll('[data-app-name]')) node.textContent = APP_NAME;
  if (root === document && document.title.includes('メモシンク')) document.title = document.title.replace('メモシンク', APP_NAME);
}

// バックグラウンドに処理を頼む。起動直後で受け手がいないときは 1 回だけやり直す
export async function send(type, payload = {}) {
  const message = { type, ...payload };
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    response = await chrome.runtime.sendMessage(message);
  }
  if (!response?.ok) throw new Error(response?.error ?? '処理に失敗しました');
  return response.result;
}

// 同期の状態を短い文字に。Chrome の同期機能は、Chrome の同期がオフでも書き込みは成功するので
// （届いたかどうかは拡張機能から分からない）、「同期済み」ではなく「保存済み」と言う
export function describeStatus(status) {
  if (!status) return { tone: 'idle', text: '未同期', title: 'まだ同期していません' };
  const lastOk = status.lastOkAt ? `最後に同期できたのは ${formatDateTime(status.lastOkAt)} です。` : 'まだ一度も同期できていません。';
  switch (status.state) {
    case 'syncing':
      return { tone: 'busy', text: '同期中…', title: `${MODE_LABELS[status.mode] ?? ''}と同期しています` };
    case 'ok':
      return status.mode === 'chrome'
        ? {
            tone: 'ok',
            text: `保存済み ${formatWhen(status.at)}`,
            title: `${formatDateTime(status.at)} に Chrome の同期機能に渡しました。Chrome の同期がオンなら、ほかの PC にも届きます。`,
          }
        : { tone: 'ok', text: `同期済み ${formatWhen(status.at)}`, title: `${formatDateTime(status.at)} に Google ドライブと同期しました` };
    case 'auth':
      return { tone: 'error', text: 'ドライブ未接続', title: `${status.message ?? ''}${lastOk}` };
    default:
      return { tone: 'error', text: status.kind === 'quota' ? '容量オーバー' : '同期エラー', title: `${status.message ?? ''}${lastOk}` };
  }
}

// 同期に失敗しているときに帯で出す内容。失敗していなければ null。
// action は次にすること：'connect'（ドライブに接続し直す）・'settings'（設定を開く）・'retry'（もう一度同期）
export function describeProblem(status) {
  if (!status || !['auth', 'error'].includes(status.state)) return null;
  const since = status.lastOkAt ? `最後に同期できたのは ${formatWhen(status.lastOkAt)}。` : '';
  const head = 'この PC には保存されていますが、ほかの PC にはまだ届いていません。';
  if (status.state === 'auth') return { text: `${head}${status.message ?? ''}${since}`, action: 'connect' };
  if (status.kind === 'quota') return { text: `${head}${status.message ?? ''}${since}`, action: 'settings' };
  return { text: `${head}${status.message ?? ''}${since}`, action: 'retry' };
}

export function downloadText(fileName, text) {
  downloadBlob(fileName, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}

export function downloadBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function firstLine(text) {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

// バックグラウンド（サービスワーカー）。保存と同期は Engine に任せ、
// ここでは Chrome の API とイベントをつなぐだけにする。
// イベントの登録は、サービスワーカーが起きた直後に毎回同じ順で行う必要がある。

import { Engine } from './lib/engine.js';
import { createChromeSyncBackend } from './lib/chrome-sync.js';
import { createDriveBackend } from './lib/drive-sync.js';
import { AuthError, errorText } from './lib/errors.js';
import { readLocalDoc } from './lib/local-doc.js';
import { displayTitle, visibleIds } from './lib/model.js';

const APP_NAME = chrome.i18n.getMessage('appName') || 'ちょこメモ';

async function getDriveToken() {
  try {
    const result = await chrome.identity.getAuthToken({ interactive: false });
    const token = typeof result === 'string' ? result : result?.token;
    if (token) return token;
  } catch {
    // 下の AuthError にまとめる
  }
  throw new AuthError('Google ドライブに接続されていません。接続し直してください。');
}

const engine = new Engine({
  local: chrome.storage.local,
  backends: {
    chrome: createChromeSyncBackend(chrome.storage.sync),
    drive: createDriveBackend({
      fetch: (...args) => fetch(...args),
      getToken: getDriveToken,
      dropToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
    }),
  },
});

// 右クリックで送ったときの結果を、ツールバーのアイコンに少しだけ出す。
// 失敗は、次にメモの画面を開いたときにも理由を出せるよう覚えておく（deliveryError）
let badgeTimer = null;
async function flash(ok, message) {
  clearTimeout(badgeTimer);
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#187561' : '#b42318' });
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  await chrome.action.setTitle({ title: `${APP_NAME}：${message}` });
  if (ok) await chrome.storage.local.remove('deliveryError');
  else await chrome.storage.local.set({ deliveryError: { message, at: Date.now() } });
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    showSyncBadge();
  }, ok ? 2_500 : 8_000);
}

// 同期に失敗している間は、アイコンに「!」を付けたままにする（画面を閉じていても気づけるように）
async function showSyncBadge(status) {
  if (badgeTimer) return;
  status ??= (await chrome.storage.local.get('status')).status;
  const failing = status && ['auth', 'error'].includes(status.state);
  await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  await chrome.action.setBadgeText({ text: failing ? '!' : '' });
  await chrome.action.setTitle({ title: failing ? `${APP_NAME}：同期できていません。${status.message ?? ''}` : APP_NAME });
}

// 送り先のメモを「メモ 3「会議メモ」」の形で言う
async function memoName(memoId) {
  const doc = await readLocalDoc(chrome.storage.local);
  const number = visibleIds(doc).indexOf(memoId) + 1;
  // 隠しているメモは中身を出さない（displayTitle が「隠しているメモ」にする）
  const title = displayTitle(doc.memos[memoId] ?? { text: '' }, 20);
  return number ? `メモ ${number}${title ? `「${title}」` : ''}` : 'メモ';
}

// ツールバーのアイコンを押したときに、ポップアップとサイドパネルのどちらで開くか（設定画面で選ぶ）。
// Chrome を起動し直したときも同じになるよう、サービスワーカーが起きるたびに合わせ直す
async function applyOpenIn(openIn) {
  if (openIn === undefined) ({ prefs: { openIn } = {} } = await chrome.storage.local.get('prefs'));
  const panel = openIn === 'panel';
  await chrome.action.setPopup({ popup: panel ? '' : 'ui/popup.html' });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel });
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'send-selection', title: `選んだ文字を${APP_NAME}に送る`, contexts: ['selection'] });
  });
}

async function ensureAlarms() {
  if (!(await chrome.alarms.get('flush'))) await chrome.alarms.create('flush', { periodInMinutes: 1 });
  if (!(await chrome.alarms.get('poll'))) await chrome.alarms.create('poll', { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  createMenus();
  // はじめて入れたときだけ、メモの画面に同期の方式などの案内を出す（閉じると消える）
  if (reason === 'install') await chrome.storage.local.set({ onboarding: true });
  await engine.ready();
  await ensureAlarms();
  engine.sync();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  engine.sync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  engine.onAlarm(alarm.name);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') engine.onRemoteChange(changes);
  if (area === 'local' && changes.prefs && changes.prefs.oldValue?.openIn !== changes.prefs.newValue?.openIn) {
    applyOpenIn(changes.prefs.newValue?.openIn);
  }
  if (area === 'local' && changes.status && changes.status.newValue?.state !== 'syncing') showSyncBadge(changes.status.newValue);
});

applyOpenIn().catch(() => {});
showSyncBadge().catch(() => {});

// 選んだ文字を、どのページから持ってきたかと一緒に、表示中のメモの最後に足す
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'send-selection' || !info.selectionText) return;
  const title = tab?.title?.trim();
  const source = [title && title !== info.pageUrl ? title : '', info.pageUrl ?? ''].filter(Boolean).join(' ');
  try {
    const { memoId } = await engine.appendText(source ? `${info.selectionText}\n出典: ${source}` : info.selectionText);
    await flash(true, `選んだ文字を${await memoName(memoId)}に送りました`);
  } catch (error) {
    await flash(false, errorText(error));
  }
});

const handlers = {
  ready: () => engine.ready(),
  edit: (msg) => engine.edit(msg.id, msg.text, msg.at),
  add: (msg) => engine.add(msg.group),
  label: (msg) => engine.label(msg.id, msg.changes),
  renameGroup: (msg) => engine.renameGroup(msg.from, msg.to),
  driveUsage: () => engine.driveUsage(),
  remove: (msg) => engine.remove(msg.id),
  reorder: (msg) => engine.reorder(msg.ids),
  addImage: (msg) => engine.addImage(msg.memoId, msg.image, { no: msg.no }),
  removeImage: (msg) => engine.removeImage(msg.id),
  replaceImage: (msg) => engine.replaceImage(msg.id, msg.image),
  revertImage: (msg) => engine.revertImage(msg.id, msg.trashId),
  restoreTrash: (msg) => engine.restoreTrash(msg.id),
  deleteTrash: (msg) => engine.deleteTrash(msg.id),
  sync: () => engine.sync(),
  setMode: (msg) => engine.setMode(msg.mode),
  import: (msg) => engine.importItems(msg.items, msg.strategy),
  restore: (msg) => engine.restore(msg.at),
  restoreBackupMemo: (msg) => engine.restoreBackupMemo(msg.at, msg.id),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // この拡張機能の画面からのメッセージだけを受け付ける
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error?.message ?? String(error) }),
    );
  return true;
});

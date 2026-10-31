// 設定画面：同期方式の切り替え、表示、キー操作、メモのコピー、取り込み・書き出し（バックアップ・ゴミ箱は別のファイル）

import { visibleIds } from '../lib/model.js';
import { readLocalDoc } from '../lib/local-doc.js';
import { SYNC_QUOTA_BYTES } from '../lib/chrome-sync.js';
import { isExportText, parseBackupText, parseBackupZip } from '../lib/backup-format.js';
import { chromeSyncBytes, chromeSyncFit, liveImageCount, otherSyncBytes } from '../lib/settings-checks.js';
import { listZip } from '../lib/zip.js';
import { prepareImage } from '../lib/image-prepare.js';
import { TIME_FORMATS } from '../lib/time-format.js';
import { describeError } from '../lib/errors.js';
import { applyAppName, describeProblem, describeStatus, firstLine, send } from './common.js';
import { exportAll } from './export.js';
import { setupBackups } from './options-backups.js';
import { setupTrash } from './options-trash.js';
import { confirmInline, setMessage, showError } from './options-ui.js';

// プライバシーポリシーを公開したら、その URL をここに入れる（空の間はリンクを出さない）
const PRIVACY_POLICY_URL = '';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ZIP_BYTES = 300 * 1024 * 1024;
// 取り込む画像の元の大きさの上限（取り込むときに縮めるので、貼れる上限より大きくてよい）
const MAX_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const modeRadios = [...document.querySelectorAll('input[name="mode"]')];
const strategyRadios = [...document.querySelectorAll('input[name="strategy"]')];
const accentRadios = [...document.querySelectorAll('input[name="accent"]')];
const manifest = chrome.runtime.getManifest();
const clientId = manifest.oauth2?.client_id ?? '';
const driveConfigured = clientId !== '' && !clientId.startsWith('YOUR_');
const isMac = /Mac/.test(navigator.platform);

let currentMode = 'chrome';
let chosenMode = null; // ラジオボタンで選んだが、まだ切り替えていない方式
let choiceConnected = false; // ドライブを選んだとき、すでに接続しているか（ボタンの動きを決める）
let pendingImport = null; // { items, hadContent, canImages, visible }

async function driveToken() {
  try {
    const result = await chrome.identity.getAuthToken({ interactive: false });
    return typeof result === 'string' ? result : (result?.token ?? null);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ---- 同期 ----

// Chrome の同期機能に切り替えたときの見積もり（メモと、同期の領域にあるグループの色など）
async function chromeSyncEstimate() {
  const doc = await readLocalDoc(chrome.storage.local);
  const others = otherSyncBytes(await chrome.storage.sync.get(null));
  return { ...chromeSyncFit(chromeSyncBytes(doc) + others), images: liveImageCount(doc) };
}

// 切り替えたときにメモがどうなるか（両方のメモが並び、同じメモは後から書いた方が残る）
function mergeNote(target) {
  const where = target === 'drive' ? 'Google ドライブ' : 'Chrome の同期機能';
  return (
    `この PC のメモと、ほかの PC が${where}に保存したメモが両方並びます。` +
    '同じメモを両方で書き換えていたら、あとから書いた方を残します。切り替える前の状態はバックアップに残ります。'
  );
}

async function renderSync() {
  const { settings, status } = await chrome.storage.local.get(['settings', 'status']);
  currentMode = settings?.mode ?? 'chrome';
  if (chosenMode === currentMode) chosenMode = null;
  const shown = chosenMode ?? currentMode;
  for (const radio of modeRadios) {
    radio.checked = radio.value === shown;
    if (radio.value === 'drive') radio.disabled = !driveConfigured && currentMode !== 'drive';
  }
  $('drive-unavailable').hidden = driveConfigured;
  $('chrome-detail').hidden = currentMode !== 'chrome';
  $('drive-detail').hidden = currentMode !== 'drive';
  renderStatus(status);
  await renderChoice();
  if (currentMode === 'chrome') await renderUsage();
  else await renderDrive();
}

// ラジオボタンで別の方式を選んだら、何が起きるかを出し、ボタンで切り替える（選んだだけでは切り替えない）
async function renderChoice() {
  const box = $('mode-choice');
  if (!chosenMode) {
    box.hidden = true;
    return;
  }
  const apply = $('mode-apply');
  const lines = [];
  if (chosenMode === 'drive') {
    const connected = (await driveToken()) !== null;
    choiceConnected = connected;
    lines.push(connected ? 'Google ドライブ同期に切り替えます。' : 'Google のログイン画面でアクセスを許可すると、Google ドライブ同期に切り替わります。');
    lines.push(mergeNote('drive'));
    lines.push('画像も貼れるようになります。ほかの PC でも、同じように Google ドライブ同期を選んでください。');
    apply.textContent = connected ? 'この方式にする' : 'Google ドライブに接続して切り替える';
    apply.disabled = false;
  } else {
    const estimate = await chromeSyncEstimate();
    lines.push(`今のメモは約 ${estimate.kb}KB です。Chrome の同期機能は 100KB までです。`);
    if (!estimate.fits) {
      lines.push('上限を超えるため、このままでは切り替えられません。メモを短くするか減らしてから、もう一度選んでください。');
    } else {
      lines.push(mergeNote('chrome'));
      if (estimate.images) lines.push(`貼った画像 ${estimate.images} 枚は、この PC には残りますが、ほかの PC とは同期されなくなります。`);
      lines.push('Google ドライブの中のメモは消えません。');
    }
    apply.textContent = 'この方式にする';
    apply.disabled = !estimate.fits;
  }
  $('mode-choice-text').textContent = lines.join('\n');
  box.hidden = false;
}

function renderStatus(status) {
  const { tone, text, title } = describeStatus(status);
  $('sync-status').className = `status ${tone}`;
  $('sync-status').textContent = text;
  $('sync-status').title = title;
  // 同期し直している間は、前の失敗の知らせをそのまま残す（出たり消えたりしないように）
  if (status?.state === 'syncing') return;
  const problem = describeProblem(status);
  $('sync-problem').hidden = !problem;
  if (!problem) return;
  // 同じ文のまま書き直すと、読み上げがもう一度割り込むので、変わったときだけ書く
  if ($('sync-problem-text').textContent !== problem.text) $('sync-problem-text').textContent = problem.text;
  const action = $('sync-problem-action');
  action.textContent = { connect: 'Google ドライブに接続し直す', settings: '同期の方式を見直す', retry: 'もう一度同期する' }[problem.action];
  action.dataset.action = problem.action;
}

async function renderUsage() {
  const used = await chrome.storage.sync.getBytesInUse(null);
  $('usage-meter').value = used;
  $('usage-text').textContent = `${(used / 1024).toFixed(1)}KB / ${SYNC_QUOTA_BYTES / 1024}KB`;
}

async function renderDrive() {
  const connected = (await driveToken()) !== null;
  $('drive-state').textContent = connected
    ? 'Google ドライブに接続済みです。'
    : 'Google ドライブに接続されていません。下のボタンから接続してください。';
  $('drive-connect').hidden = connected;
  $('drive-disconnect').hidden = !connected;
  $('drive-usage-refresh').hidden = !connected;
  if (connected) renderDriveUsage();
  else $('drive-usage').hidden = true;
}

async function renderDriveUsage() {
  const meter = $('drive-meter');
  $('drive-usage').hidden = false;
  $('drive-app-usage').textContent = '読み込み中…';
  $('drive-total-usage').textContent = '読み込み中…';
  meter.hidden = true;
  setMessage('drive-usage-message', '');
  try {
    const usage = await send('driveUsage');
    const images = usage.imageFiles ? `、うち画像 ${usage.imageFiles} 枚 ${formatBytes(usage.imageBytes)}` : '';
    $('drive-app-usage').textContent = `${formatBytes(usage.appBytes)}${images}`;
    if (usage.driveUsage === null) {
      $('drive-total-usage').textContent = '読み取れませんでした';
    } else if (!usage.driveLimit) {
      $('drive-total-usage').textContent = `${formatBytes(usage.driveUsage)} 使用中・上限なし`;
    } else {
      meter.hidden = false;
      meter.value = Math.min(1, usage.driveUsage / usage.driveLimit);
      const percent = Math.round((usage.driveUsage / usage.driveLimit) * 100);
      $('drive-total-usage').textContent = `${formatBytes(usage.driveUsage)} / ${formatBytes(usage.driveLimit)}・${percent}%`;
    }
  } catch (error) {
    $('drive-app-usage').textContent = '—';
    $('drive-total-usage').textContent = '—';
    showError('drive-usage-message', error, '使用量を読み取れませんでした。');
  }
}

// 切り替えて同期する。うまく切り替わったら true
async function switchMode(mode) {
  setMessage('sync-message', '切り替えて同期しています…');
  let ok = false;
  try {
    const status = await send('setMode', { mode });
    const doc = await readLocalDoc(chrome.storage.local);
    const images = liveImageCount(doc);
    const note = mode === 'chrome' && images ? `貼った画像 ${images} 枚はこの PC に残りますが、同期はされません。` : '';
    chosenMode = null;
    if (status.state === 'ok') {
      setMessage('sync-message', `${mode === 'drive' ? 'Google ドライブ同期' : 'Chrome の同期機能'}に切り替えました。${note}`, 'ok');
      ok = true;
    } else {
      const { message, detail } = describeError(status.message);
      setMessage('sync-message', `切り替えましたが、同期できませんでした。${message}`, 'error', { detail });
    }
  } catch (error) {
    showError('sync-message', error, '切り替えられませんでした。');
  }
  await renderSync();
  return ok;
}

// Google のログイン画面は、ボタンを押した流れの中でしか出せない
async function connectDrive() {
  setMessage('sync-message', 'Google のログイン画面で、アクセスを許可してください…');
  let token = null;
  try {
    const result = await chrome.identity.getAuthToken({ interactive: true });
    token = typeof result === 'string' ? result : result?.token;
  } catch (error) {
    showError('sync-message', error, 'Google ドライブに接続できませんでした。');
    await renderSync();
    return;
  }
  if (!token) {
    setMessage('sync-message', 'Google ドライブに接続できませんでした。Google のログイン画面で許可されませんでした。', 'error');
    await renderSync();
    return;
  }
  if (currentMode === 'drive') {
    // 接続し直しただけ：同期し直す
    await syncNow();
    await renderDrive();
  } else {
    await switchMode('drive');
  }
}

// アクセスの許可そのものを Google 側で取り消してから、Chrome の同期機能に戻す
async function disconnectDrive() {
  const token = await driveToken();
  if (token) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
    await chrome.identity.removeCachedAuthToken({ token });
  }
  await chrome.identity.clearAllCachedAuthTokens?.();
  // 切り替えに失敗したときは、その失敗の知らせを残す（成功の文で上書きしない）
  if (await switchMode('chrome')) {
    setMessage('sync-message', '接続を解除し、Chrome の同期機能に戻しました。Google ドライブの中のメモは消えていません。', 'ok');
  }
}

async function confirmDisconnect() {
  const button = $('drive-disconnect');
  const estimate = await chromeSyncEstimate();
  const lines = ['接続を解除すると、Google のアクセスの許可を取り消して、Chrome の同期機能に戻ります。'];
  lines.push(`今のメモは約 ${estimate.kb}KB です。Chrome の同期機能は 100KB までです。`);
  if (!estimate.fits) lines.push('上限を超えているため、解除すると、ほかの PC とメモを同期できなくなります。');
  if (estimate.images) lines.push(`貼った画像 ${estimate.images} 枚は、この PC には残りますが、ほかの PC とは同期されなくなります。`);
  lines.push('Google ドライブの中のメモは消えません。もう一度接続すれば使えます。');
  confirmInline($('drive-detail'), {
    text: lines.join(''),
    yesLabel: '接続を解除する',
    returnFocus: button,
    onYes: async () => {
      await disconnectDrive();
      $('sync-title').focus();
    },
  });
}

async function syncNow() {
  setMessage('sync-message', '同期しています…');
  try {
    const status = await send('sync');
    if (status.state === 'ok') setMessage('sync-message', '同期しました。', 'ok');
    else {
      const { message, detail } = describeError(status.message ?? '');
      setMessage('sync-message', `同期できませんでした。${message}`, 'error', { detail });
    }
  } catch (error) {
    showError('sync-message', error, '同期できませんでした。');
  }
  await renderSync();
}

for (const radio of modeRadios) {
  radio.addEventListener('change', () => {
    chosenMode = radio.value === currentMode ? null : radio.value;
    renderChoice();
  });
}
// Google のログイン画面を出すときは、押した直後に（ほかの待ちを挟まずに）呼ぶ
$('mode-apply').addEventListener('click', () => {
  if (chosenMode === 'drive') {
    if (choiceConnected) switchMode('drive');
    else connectDrive();
  } else if (chosenMode === 'chrome') {
    switchMode('chrome');
  }
});
$('mode-cancel').addEventListener('click', () => {
  chosenMode = null;
  renderSync();
  modeRadios.find((radio) => radio.value === currentMode)?.focus();
});

$('drive-connect').addEventListener('click', connectDrive);
$('drive-disconnect').addEventListener('click', confirmDisconnect);
$('drive-usage-refresh').addEventListener('click', renderDriveUsage);
$('open-sync-settings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/syncSetup/advanced' }));
$('sync-now').addEventListener('click', syncNow);
$('sync-problem-action').addEventListener('click', (event) => {
  const action = event.currentTarget.dataset.action;
  if (action === 'connect') connectDrive();
  else if (action === 'retry') syncNow();
  else (modeRadios.find((radio) => radio.checked) ?? modeRadios[0]).focus();
});

// ---- 表示 ----

async function renderPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  const select = $('time-format');
  const now = new Date();
  select.replaceChildren(
    ...Object.entries(TIME_FORMATS).map(([value, { note, format }]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${format(now)}${note}`;
      return option;
    }),
  );
  select.value = prefs?.timeFormat in TIME_FORMATS ? prefs.timeFormat : 'ja';
  $('tab-label').value = prefs?.tabLabel === 'title' ? 'title' : 'number';
  $('open-in').value = prefs?.openIn === 'panel' ? 'panel' : 'popup';
  $('theme').value = ['light', 'dark'].includes(prefs?.theme) ? prefs.theme : 'auto';
  const accent = accentRadios.some((radio) => radio.value === prefs?.accent) ? prefs.accent : 'green';
  for (const radio of accentRadios) radio.checked = radio.value === accent;
  $('text-size').value = ['small', 'large'].includes(prefs?.textSize) ? prefs.textSize : 'normal';
  $('popup-width').value = ['narrow', 'wide', 'max'].includes(prefs?.popupWidth) ? prefs.popupWidth : 'normal';
  const height = Number.isFinite(prefs?.memoHeight) ? prefs.memoHeight : null;
  $('memo-height-text').textContent = height
    ? `${height}px にしています。入力欄の右下の角をドラッグすると変えられます。`
    : 'ふつうの 300px です。入力欄の右下の角をドラッグすると変えられ、次に開いたときもその高さになります。';
  $('memo-height-reset').hidden = !height;
}

// 表示の設定を 1 つ変える（undefined なら消して既定に戻す）
async function setPref(key, value) {
  const { prefs } = await chrome.storage.local.get('prefs');
  const next = { ...prefs, [key]: value };
  if (value === undefined) delete next[key];
  await chrome.storage.local.set({ prefs: next });
}

for (const [id, key] of [
  ['tab-label', 'tabLabel'],
  ['open-in', 'openIn'],
  ['theme', 'theme'],
  ['text-size', 'textSize'],
  ['popup-width', 'popupWidth'],
]) {
  $(id).addEventListener('change', (event) => setPref(key, event.target.value));
}
for (const radio of accentRadios) radio.addEventListener('change', () => setPref('accent', radio.value));
$('memo-height-reset').addEventListener('click', async () => {
  await setPref('memoHeight', undefined);
  // ボタンが消えるので、説明の文にキー操作の場所を移す
  $('memo-height-text').focus();
});
$('time-format').addEventListener('change', (event) => setPref('timeFormat', event.target.value));

// ---- キー操作・右クリック ----

async function renderShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = (name) => commands.find((command) => command.name === name)?.shortcut || '未設定';
  $('shortcut-open').textContent = shortcut('_execute_action');
  $('shortcut-search').textContent = isMac ? '⌘F' : 'Ctrl+F';
  $('shortcut-replace').textContent = isMac ? '⌘⇧H' : 'Ctrl+H';
  $('shortcut-preview').textContent = isMac ? '⌘E' : 'Ctrl+E';
  $('shortcut-bold').textContent = isMac ? '⌘B' : 'Ctrl+B';
  $('shortcut-italic').textContent = isMac ? '⌘I' : 'Ctrl+I';
  $('shortcut-strike').textContent = isMac ? '⌘⇧X' : 'Ctrl+Shift+X';
  $('shortcut-code').textContent = isMac ? '⌘⇧C' : 'Ctrl+Shift+C';
}

// ショートカットは Chrome の画面でしか変えられない
$('change-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---- メモのコピー（画像をファイルに保存する許可） ----

const DOWNLOADS = { permissions: ['downloads'] };

async function renderCopyPermission() {
  const granted = await chrome.permissions.contains(DOWNLOADS);
  $('copy-permission').textContent = granted
    ? '画像のファイル保存：許可しています'
    : '画像のファイル保存：まだ許可していません。画像付きのメモをコピーするときに聞きます。';
  $('copy-permission-button').textContent = granted ? '許可を取り消す' : '許可する';
  $('copy-permission-button').className = granted ? '' : 'primary';
}

$('copy-permission-button').addEventListener('click', async () => {
  try {
    if (await chrome.permissions.contains(DOWNLOADS)) {
      await chrome.permissions.remove(DOWNLOADS);
      setMessage('copy-message', '許可を取り消しました。画像付きのメモは、文章だけをコピーするか、もう一度許可してからコピーします。', 'ok');
    } else if (await chrome.permissions.request(DOWNLOADS)) {
      $('copy-permission-row').classList.remove('highlight');
      setMessage('copy-message', '許可しました。メモの画面に戻って、もう一度「コピー」を押してください。', 'ok', { keepFor: 30_000 });
    } else {
      setMessage('copy-message', '許可されませんでした。画像は入れずに、文章だけをコピーできます。', 'error');
    }
  } catch (error) {
    showError('copy-message', error, '許可を変えられませんでした。');
  }
  await renderCopyPermission();
});
chrome.permissions.onAdded.addListener(renderCopyPermission);
chrome.permissions.onRemoved.addListener(renderCopyPermission);

// ---- 取り込み・書き出し ----

function resetImport() {
  pendingImport = null;
  $('import-file').value = '';
  $('import-file-name').textContent = 'まだ選んでいません。ここにファイルをドラッグしても選べます。';
  $('import-preview').hidden = true;
}

// .txt は文字だけ、.zip（このアプリの画像入りの書き出し）は文字と画像。
// plain は、書き出したファイルの形ではない普通の .txt（ファイル全体を 1 件のメモにする）
async function readImportFile(file) {
  const isZip = /\.zip$/i.test(file.name) || /zip/.test(file.type);
  const limit = isZip ? MAX_IMPORT_ZIP_BYTES : MAX_IMPORT_BYTES;
  if (file.size > limit) throw new Error(`ファイルが大きすぎます。${limit / 1024 / 1024}MB までです。`);
  if (isZip) return { items: await parseBackupZip(listZip(new Uint8Array(await file.arrayBuffer()))), plain: false };
  const text = await file.text();
  return { items: parseBackupText(text).map((item) => ({ ...item, images: [] })), plain: !isExportText(text) };
}

// 選んだ取り込み方で、今のメモがどうなるかを書く
function renderStrategyNote() {
  if (!pendingImport) return;
  const { items, visible } = pendingImport;
  const strategy = strategyRadios.find((radio) => radio.checked)?.value ?? 'append';
  if (strategy === 'replace') {
    const replaced = Math.min(items.length, visible);
    const added = Math.max(0, items.length - visible);
    $('import-strategy-note').textContent =
      `今のメモ 1〜${replaced} の中身が、ファイルのメモ 1〜${replaced} に置き換わります。` +
      '名前・グループ・「隠す」の印・貼ってある画像は、置き換えたあとも残ります。' +
      (added ? `ファイルの方が多い ${added} 件は、後ろに追加します。` : '') +
      '取り込む前の状態はバックアップに残ります。';
  } else {
    const count = items.filter((item) => item.text.trim() || item.images.length).length;
    $('import-strategy-note').textContent = `今あるメモはそのままで、後ろに ${count} 件を追加します。`;
  }
}

async function previewImport(file) {
  setMessage('import-message', '');
  if (!file) return resetImport();
  $('import-file-name').textContent = file.name;
  let read;
  try {
    read = await readImportFile(file);
  } catch (error) {
    resetImport();
    return showError('import-message', error, '読み込めませんでした。');
  }
  const { items, plain } = read;
  if (!items.length) {
    resetImport();
    return setMessage('import-message', 'ファイルが空で、メモが見つかりませんでした。', 'error');
  }
  const imageCount = items.reduce((n, item) => n + item.images.length, 0);
  const { settings } = await chrome.storage.local.get('settings');
  const canImages = settings?.mode === 'drive';
  $('import-summary').textContent =
    (plain
      ? 'このアプリで書き出したファイルではないので、全体を 1 つのメモとして取り込みます。'
      : `${items.length} 件のメモ${imageCount ? `と画像 ${imageCount} 枚` : ''}が見つかりました。`) +
    (imageCount && !canImages ? '今は Chrome の同期機能なので、画像は取り込まず、文字だけを取り込みます。' : '');
  $('import-list').replaceChildren(
    ...items.slice(0, 8).map((item) => {
      const li = document.createElement('li');
      const images = item.images.length ? `・画像 ${item.images.length} 枚` : '';
      li.textContent = `${firstLine(item.text) || (images ? '画像だけのメモ' : '空のメモ')}${images}`;
      return li;
    }),
  );
  if (items.length > 8) {
    const li = document.createElement('li');
    li.textContent = `ほか ${items.length - 8} 件`;
    $('import-list').append(li);
  }
  // 今のメモがすべて空なら（入れたばかりなど）番号どおり、そうでなければ後ろに追加を選んでおく
  const doc = await readLocalDoc(chrome.storage.local);
  const visible = visibleIds(doc);
  const empty = visible.every((id) => !doc.memos[id].text.trim());
  for (const radio of strategyRadios) radio.checked = radio.value === (empty ? 'replace' : 'append');
  pendingImport = { items, hadContent: !empty, canImages, visible: visible.length };
  renderStrategyNote();
  $('import-preview').hidden = false;
  $('import-summary').scrollIntoView({ block: 'nearest' });
}

$('import-file').addEventListener('change', (event) => previewImport(event.target.files[0]));
$('import-choose').addEventListener('click', () => $('import-file').click());
for (const radio of strategyRadios) radio.addEventListener('change', renderStrategyNote);

// ファイルを落としても選べる
const drop = $('import-drop');
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
drop.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  drop.classList.add('dropping');
});
drop.addEventListener('dragleave', (event) => {
  if (!drop.contains(event.relatedTarget)) drop.classList.remove('dropping');
});
drop.addEventListener('drop', (event) => {
  drop.classList.remove('dropping');
  if (!hasFiles(event)) return;
  event.preventDefault();
  previewImport(event.dataTransfer.files[0]);
});
// 枠の外に落としたときに、ファイルが開いて設定画面から離れないようにする
document.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (hasFiles(event)) event.preventDefault();
});

// 文字を取り込んでから、画像を 1 枚ずつ、取り込んだ先のメモに貼る
async function importImages(items, ids) {
  const total = items.reduce((n, item, i) => n + (ids[i] ? item.images.length : 0), 0);
  let added = 0;
  let failed = null;
  for (const [i, item] of items.entries()) {
    if (!ids[i]) continue;
    for (const image of item.images) {
      setMessage('import-message', `画像を取り込んでいます… ${added + 1} / ${total}`);
      try {
        if (image.size > MAX_IMPORT_IMAGE_BYTES) throw new Error('画像が大きすぎます。20MB までです');
        const prepared = await prepareImage(new Blob([await image.read()], { type: image.type }));
        await send('addImage', { memoId: ids[i], image: prepared, no: image.no });
        added++;
      } catch (error) {
        failed ??= describeError(error).message;
      }
    }
  }
  return { added, failed };
}

$('import-run').addEventListener('click', async () => {
  if (!pendingImport) return;
  const strategy = strategyRadios.find((radio) => radio.checked)?.value ?? 'append';
  const run = $('import-run');
  run.disabled = true;
  try {
    const { items, hadContent, canImages } = pendingImport;
    resetImport();
    const payload = items.map(({ text, images }) => ({ text, images: canImages ? images.length : 0 }));
    const { count, ids } = await send('import', { items: payload, strategy });
    const { added, failed } = canImages ? await importImages(items, ids) : { added: 0, failed: null };
    const note = hadContent ? '取り込む前の状態はバックアップに残っています。' : '';
    const problem = failed ? `取り込めなかった画像があります。${failed.replace(/。?$/, '。')}` : '';
    setMessage('import-message', `${count} 件のメモ${added ? `と画像 ${added} 枚` : ''}を取り込みました。${note}${problem}`, failed ? 'error' : 'ok');
  } catch (error) {
    showError('import-message', error, '取り込めませんでした。');
  }
  run.disabled = false;
  $('import-choose').focus();
});

$('import-cancel').addEventListener('click', () => {
  resetImport();
  $('import-choose').focus();
});

$('export').addEventListener('click', async () => {
  const button = $('export');
  button.disabled = true;
  setMessage('export-message', '書き出しています…');
  try {
    const { images, missing } = await exportAll();
    const note = missing ? `まだこの PC に届いていない画像 ${missing} 枚は入っていません。` : '';
    setMessage('export-message', images ? `メモと画像 ${images} 枚を ZIP に書き出しました。${note}` : `書き出しました。${note}`, 'ok');
  } catch (error) {
    showError('export-message', error, '書き出せませんでした。');
  }
  button.disabled = false;
});

// ---- このアプリについて ----

function renderAbout() {
  $('version').textContent = manifest.version;
  if (PRIVACY_POLICY_URL) {
    $('privacy-policy').href = PRIVACY_POLICY_URL;
    $('privacy-link').hidden = false;
  }
}

// ---- 開いたときの場所 ----

const backups = setupBackups();

// メモの画面から開いたとき（#copy-title・#conflict-<時刻> など）は、その場所を見せる
async function showHashTarget() {
  if (await backups.openFromHash()) return;
  const id = location.hash.slice(1);
  const target = id && document.getElementById(id);
  if (!target) return;
  if (id === 'copy-title') {
    const row = $('copy-permission-row');
    if (!(await chrome.permissions.contains(DOWNLOADS))) row.classList.add('highlight');
    target.scrollIntoView({ block: 'start' });
    $('copy-permission-button').focus({ preventScroll: true });
    return;
  }
  target.scrollIntoView({ block: 'start' });
  if (target.tabIndex >= 0 || target.hasAttribute('tabindex')) target.focus({ preventScroll: true });
}

// ---- 目次 ----

// いま見ている欄の目次に印を付ける（広い画面で右に並べたときに、どこにいるか分かるように）。
// 画面の上から 1/3 の線を越えた最後の欄を「いま見ている欄」とし、いちばん下まで来たら最後の欄にする。
// 目次で選んだ欄は、画面に見えている間はそのまま印を付けておく（下の方の短い欄を選んでも、印が最後の欄にずれないように）
function setupToc() {
  const links = [...document.querySelectorAll('.toc a')];
  const sections = links.map((link) => document.querySelector(`[aria-labelledby="${link.hash.slice(1)}"]`));
  let chosen = -1;
  let frame = 0;
  const visible = (section) => {
    const rect = section.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  };
  const mark = () => {
    frame = 0;
    if (chosen >= 0 && !visible(sections[chosen])) chosen = -1;
    let at = 0;
    sections.forEach((section, i) => {
      if (section.getBoundingClientRect().top <= window.innerHeight / 3) at = i;
    });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) at = sections.length - 1;
    if (chosen >= 0) at = chosen;
    links.forEach((link, i) => {
      if (i === at) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(mark);
  };
  links.forEach((link, i) =>
    link.addEventListener('click', () => {
      chosen = i;
      schedule();
    }),
  );
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  mark();
}

// ---- 起動 ----

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.status) renderStatus(changes.status.newValue);
    if (changes.settings) renderSync();
    if (changes.prefs) renderPrefs();
  } else if (area === 'sync') {
    renderUsage();
  }
});
window.addEventListener('hashchange', showHashTarget);

applyAppName();
renderAbout();
setupTrash();
setupToc();
Promise.all([renderSync(), renderPrefs(), renderShortcut(), renderCopyPermission(), backups.load()]).then(showHashTarget);

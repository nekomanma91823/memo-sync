// メモ編集画面（ポップアップとサイドパネルで共通）。
//
// 保存はバックグラウンドに頼み、画面は chrome.storage.local の変化を見て表示を合わせる。
// 入力中の文字を、少し前の自分の保存や他の端末の古い内容で上書きしないように、
// 画面側でも「どの版まで知っているか」（updatedAt）を持っておく。
//
// グループで絞り込んでいるときは、そのグループのタブだけを出す（番号は全体での番号のまま）。
// 「隠す」にしたメモは、「表示する」を押すまで中身を出さない。別のメモに移るか画面を閉じると、また隠す。
// パスワード・API キー・個人情報らしい文字は、入力欄の下とタブに印を出す（sensitive-bar.js）。
//
// お知らせはツールバーの下の行（notice.js）、同期の問題やはじめての案内は上の帯に出す。
// 出したもの（確認・帯・メニュー）は、どれも Esc で閉じられる。
//
// タブは番号だけ。グループはタブの上の行に並べ、タブを上のグループにドラッグすると入る（「すべて」に落とすと外れる）。
// 新しいグループは行の右端の「＋ グループ」から作り、表示中のメモを入れる（その場で名前を書く。inline-edit.js）。
// グループの色とやめるは、グループの ▾ か右クリックで出すメニュー（menu.js）から。

import {
  MAX_GROUP_LENGTH,
  MAX_MEMOS,
  MAX_TEXT_LENGTH,
  MIN_MEMOS,
  cleanLabel,
  groupNames,
  labelFields,
  labelOf,
  memoImageIds,
  setLabel,
  visibleIds,
} from '../lib/model.js';
import { MEMO_PREFIX, docFromParts, memoKey } from '../lib/local-doc.js';
import { extractLinks, linkLabel } from '../lib/links.js';
import { formatTimestamp, formatWhen } from '../lib/time-format.js';
import { GROUP_COLORS, GROUP_COLOR_KEY, assignGroupColors, readGroupColors, renameGroupColor } from '../lib/group-colors.js';
import { errorText } from '../lib/errors.js';
import { APP_NAME, MODE_LABELS, applyAppName, describeProblem, describeStatus, firstLine, send } from './common.js';
import { createImageStrip } from './images.js';
import { createSearch } from './search.js';
import { createPreview } from './preview.js';
import { toggleTask } from '../lib/markdown.js';
import { createMemoCopy } from './memo-copy.js';
import { createSensitiveBar } from './sensitive-bar.js';
import { createNotices } from './notice.js';
import { createMenu, isMenuKey } from './menu.js';
import { editInline } from './inline-edit.js';

const view = document.body.dataset.view;
const $ = (id) => document.getElementById(id);
const el = {
  editor: document.querySelector('.editor'),
  groups: $('groups'),
  tabs: $('tabs'),
  openSearch: $('open-search'),
  toggleVeil: $('toggle-veil'),
  togglePreview: $('toggle-preview'),
  preview: $('preview'),
  tabMenu: $('tab-menu'),
  veil: $('veil'),
  veilShow: $('veil-show'),
  veilOff: $('veil-off'),
  add: $('add'),
  remove: $('remove'),
  alert: $('alert'),
  alertText: $('alert-text'),
  alertOpen: $('alert-open'),
  alertClose: $('alert-close'),
  confirmTabs: $('confirm-tabs'),
  confirmTabsYes: $('confirm-tabs-yes'),
  confirmTabsNo: $('confirm-tabs-no'),
  memo: $('memo'),
  insertTime: $('insert-time'),
  insertUrl: $('insert-url'),
  count: $('count'),
  status: $('status'),
  links: $('links'),
  linkList: $('link-list'),
  openLinks: $('open-links'),
  confirmLinks: $('confirm-links'),
  confirmLinksText: $('confirm-links-text'),
  confirmLinksYes: $('confirm-links-yes'),
  confirmLinksNo: $('confirm-links-no'),
  switchView: $('switch-view'),
  openOptions: $('open-options'),
  viewer: $('viewer'),
};

// リンクの一覧に並べる数（残りは「すべて開く」の数で分かる）
const LINKS_SHOWN = 6;
// これより多いリンクを「すべて開く」ときは確かめる
const LINKS_CONFIRM = 10;
const UNDO_FOR = 10_000;

const state = {
  ready: false,
  meta: null,
  values: {}, // memo:<id> → { text, updatedAt }
  images: {}, // 画像の記録（本体は images.js が読む）
  mode: 'chrome',
  doc: { order: [], orderUpdatedAt: 0, memos: {}, images: {} },
  currentId: null,
  group: null, // 絞り込んでいるグループ（null はすべて）
  visible: [],
  shown: [], // タブに出しているメモ（グループで絞り込んだもの）
  groups: [], // グループの名前（並んでいる順）
  revealedId: null, // 隠しているメモのうち、今だけ「表示する」を押したもの
  preview: false, // 書式を付けて表示している間。画面を開くたびに編集から始める
  groupColors: {}, // 自分で選んだグループの色（Chrome の同期機能に置く）
  colorMap: {}, // 今出しているグループの色（選んでいないものも含む）
  inlineEditing: false, // タブやグループの名前をその場で書き換えている間（その間はタブを作り直さない）
  pendingRender: false,
  lastEditAt: 0,
  sent: [], // 直近に保存を頼んだ本文。戻ってきた自分の保存で入力欄を書き換えないため
  composing: false,
  pendingExternal: false,
  applyingExternal: false, // 他の端末の内容を入力欄に映している間（その入力は保存し直さない）
  removingId: null, // この画面で削除したメモ（ほかの PC で消されたと知らせないため）
  prefs: {},
  links: [],
  windowId: null,
  canReadTabs: false,
  statusShown: false,
  status: null,
  dirty: false,
  problemDismissed: null, // 「閉じる」を押した同期の問題（同じ問題の間は出し直さない）
  syncUsage: null, // Chrome 同期の使用量 { bytes, quota }
  quotaDismissed: null, // 「閉じる」を押した容量の知らせの段階（'warn' | 'danger'）
  shortcuts: { open: '' },
};

// ---- 部品 ----

const notices = createNotices();
const showNotice = (text, tone, options) => notices.show(text, tone, options);

function openSettings(anchor = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/options.html${anchor ? `#${anchor}` : ''}`) });
}

const preview = createPreview({
  getText: () => el.memo.value,
  onToggleTask,
  imageUrl: (no) => strip.imageUrl(no),
  openImage: (no) => strip.openImage(no),
});
const strip = createImageStrip({
  view,
  showNotice,
  onRemoved: (trashId, message) => offerUndo(trashId, message),
  onReplaced: (imageId, trashId) => offerRevert(imageId, trashId),
  canAdd: () => !isVeiled(),
  blockedMessage: '隠しているメモです。「表示する」を押してから貼ってください',
  openSettings: () => openSettings('sync-title'),
  focusEditor: () => focusEditor(),
  insertText: (text) => insertText(text),
  onPaint: () => refreshPreview(),
});
const search = createSearch({
  getDoc: () => state.doc,
  onOpen: openResult,
  onToggle: (open) => {
    el.editor.classList.toggle('searching', open);
    if (!open) focusEditor();
  },
  onReplace: applyReplace,
});

const memoCopy = createMemoCopy({
  view,
  getMemo: () => ({ doc: state.doc, memoId: state.currentId }),
  getText: () => el.memo.value,
  isVeiled: () => isVeiled(),
  showNotice,
  openMenu: (...args) => menu.open(...args),
});
const sensitive = createSensitiveBar({
  textarea: el.memo,
  getMemo: () => ({ memoId: state.currentId, hidden: !!state.doc.memos[state.currentId]?.hidden }),
  scrollToOffset,
  onHide: hideMemo,
  onJump: () => showEditor(),
});
const menu = createMenu(el.tabMenu);

// ---- 読み込み ----

async function readStorage() {
  const keys = ['meta', 'images', 'settings', 'ui', 'status', 'prefs', 'alert', 'dirty', 'onboarding', 'deliveryError'];
  let base = await chrome.storage.local.get(keys);
  if (!base.meta) {
    await send('ready');
    base = await chrome.storage.local.get(keys);
  }
  const order = Array.isArray(base.meta?.order) ? base.meta.order : [];
  state.meta = base.meta;
  state.values = order.length ? await chrome.storage.local.get(order.map(memoKey)) : {};
  state.images = base.images ?? {};
  state.mode = base.settings?.mode ?? 'chrome';
  state.prefs = base.prefs ?? {};
  state.doc = docFromParts(state.meta, state.values, state.images);
  return base;
}

async function init() {
  applyAppName();
  const base = await readStorage();
  if (!visibleIds(state.doc).length) {
    await send('add');
    await readStorage();
  }
  state.group = groupNames(state.doc).includes(base.ui?.group) ? base.ui.group : null;
  const shown = shownIds();
  state.currentId = shown.includes(base.ui?.currentId) ? base.ui.currentId : shown[0];
  state.dirty = !!base.dirty;
  // ポップアップでは「サイドパネルで開く」、サイドパネルでは「ポップアップに戻す」
  const switchLabel = view === 'popup' ? 'サイドパネルで開く' : 'ポップアップに戻す';
  el.switchView.title = switchLabel;
  el.switchView.setAttribute('aria-label', switchLabel);
  // サイドパネルの「ポップアップに戻す」で一時的に付けたポップアップを、設定どおりに外しておく
  if (view === 'popup' && state.prefs.openIn === 'panel') chrome.action.setPopup({ popup: '' }).catch(() => {});
  renderTabs();
  showCurrent();
  renderStatus(base.status);
  renderAlert(base.alert);
  renderDeliveryError(base.deliveryError);
  // 読み込みが終わるまでは書けないようにしている（メモが決まる前の入力が保存されないため）
  el.memo.readOnly = false;
  el.memo.placeholder = 'ここに書くと自動で保存します';
  state.ready = true;
  focusEditor();
  loadGroupColors();
  await showShortcuts();
  renderOnboarding(base.onboarding);
  checkSyncUsage();

  chrome.windows.getCurrent().then((win) => {
    state.windowId = win.id;
    // メモは一度に 1 か所だけに出す。ポップアップを開いたら、同じウィンドウのサイドパネルには閉じてもらう
    if (view === 'popup') chrome.runtime.sendMessage({ type: 'closePanel', windowId: win.id }).catch(() => {});
  });
  if (view === 'panel') {
    chrome.permissions.contains({ permissions: ['tabs'] }).then((granted) => {
      state.canReadTabs = granted;
    });
  }
  send('sync').catch(() => {});
  lastLiveSync = Date.now();
  setInterval(liveSync, LIVE_SYNC_INTERVAL);
}

// Google ドライブ同期では、他の端末で書き換わっても知らせが来ない。
// 画面を開いている間は 1 分ごとと、画面に戻ってきたときに取りに行く（Chrome 同期は知らせが来る）
const LIVE_SYNC_INTERVAL = 60_000;
const LIVE_SYNC_GAP = 15_000;
let lastLiveSync = 0;

function liveSync() {
  if (state.mode !== 'drive' || document.visibilityState !== 'visible') return;
  if (Date.now() - lastLiveSync < LIVE_SYNC_GAP) return;
  lastLiveSync = Date.now();
  send('sync').catch(() => {});
}

document.addEventListener('visibilitychange', liveSync);
window.addEventListener('focus', liveSync);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[GROUP_COLOR_KEY]) loadGroupColors();
  if (area !== 'local' || !state.ready) return;
  strip.onStorageChange(changes);
  // 届いた変更で今のメモが消えたときに、何番のどのメモだったかを知らせるため
  const before = { memo: state.doc.memos[state.currentId], number: state.visible.indexOf(state.currentId) + 1 };
  let structural = false;
  let currentTouched = false;
  for (const [key, change] of Object.entries(changes)) {
    if (key === 'meta') {
      state.meta = change.newValue;
      structural = true;
    } else if (key === 'images') {
      state.images = change.newValue ?? {};
      structural = true;
    } else if (key === 'settings') {
      state.mode = change.newValue?.mode ?? 'chrome';
      strip.render(state.doc, state.currentId, state.mode);
      checkSyncUsage();
    } else if (key.startsWith(MEMO_PREFIX)) {
      const known = state.values[key];
      const next = change.newValue;
      if (!next) delete state.values[key];
      else if (!known || next.updatedAt >= known.updatedAt) state.values[key] = next;
      // 本文は少し前の自分の保存でも、名前などはその後に変わっていることがある
      else if ((next.labelAt ?? -1) > (known.labelAt ?? -1)) {
        state.values[key] = { text: known.text, updatedAt: known.updatedAt, ...labelOf(next) };
      } else continue; // 少し前の自分の保存が戻ってきただけ
      structural = true;
      if (key === memoKey(state.currentId)) currentTouched = true;
    } else if (key === 'status') {
      renderStatus(change.newValue);
    } else if (key === 'dirty') {
      state.dirty = !!change.newValue;
      paintStatus(state.status);
    } else if (key === 'alert') {
      renderAlert(change.newValue);
    } else if (key === 'onboarding') {
      renderOnboarding(change.newValue);
    } else if (key === 'deliveryError') {
      renderDeliveryError(change.newValue);
    } else if (key === 'prefs') {
      state.prefs = change.newValue ?? {};
      renderTabs();
    }
  }
  if (!structural) return;
  state.doc = docFromParts(state.meta, state.values, state.images);
  if (state.group && !groupNames(state.doc).includes(state.group)) state.group = null;
  if (!shownIds().includes(state.currentId)) {
    // 並びから消えたのは削除（グループが変わっただけなら、並びには残っている）
    const removed = !visibleIds(state.doc).includes(state.currentId);
    const removedElsewhere = removed && state.removingId !== state.currentId && before.memo && !before.memo.deleted;
    moveToNeighbor();
    if (removedElsewhere) tellRemovedElsewhere(before);
    return;
  }
  if (currentTouched) applyExternal();
  renderTabs();
  strip.render(state.doc, state.currentId, state.mode);
  search.refresh();
});

// ほかの PC で削除されたメモを開いていたとき
function tellRemovedElsewhere({ memo, number }) {
  const name = memoLabel(memo);
  showNotice(`メモ ${number}${name}は、ほかの PC で削除されました。ゴミ箱から戻せます`, 'info', {
    action: { label: 'ゴミ箱を開く', run: () => openSettings('trash-title') },
    duration: 20_000,
  });
}

// 確認やお知らせでメモを指すときの 1 行目（「請求書」）。隠しているメモは中身を出さない
function memoLabel(memo) {
  if (!memo || memo.hidden) return '';
  const line = firstLine(memo.text);
  return line ? `「${line.length > 20 ? `${line.slice(0, 20)}…` : line}」` : '';
}

// ---- 表示 ----

function shownIds() {
  const visible = visibleIds(state.doc);
  return state.group ? visible.filter((id) => state.doc.memos[id].group === state.group) : visible;
}

function renderTabs() {
  const visible = visibleIds(state.doc);
  state.visible = visible;
  state.shown = shownIds();
  state.groups = groupNames(state.doc);
  state.colorMap = assignGroupColors(state.groups, state.groupColors);
  el.add.disabled = visible.length >= MAX_MEMOS;
  el.add.title = el.add.disabled ? `メモは ${MAX_MEMOS} 個までです` : 'メモを追加';
  el.remove.disabled = visible.length <= MIN_MEMOS;
  el.remove.title = el.remove.disabled ? '最後のメモは削除できません' : '表示中のメモを削除';
  renderVeil();
  // 名前をその場で書き換えている間は作り直さない（書いている欄が消えないように）。終わったら作り直す
  if (state.inlineEditing) {
    state.pendingRender = true;
    return;
  }
  renderGroups();
  // 作り直してもキー操作の場所が外れないように、選んでいたタブを覚えておく
  const focusedId = el.tabs.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const current = state.shown.includes(state.currentId) ? state.currentId : state.shown[0];
  el.tabs.replaceChildren(
    ...state.shown.map((id) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab';
      button.draggable = true;
      button.dataset.id = id;
      // タブの並びは Tab キー 1 回で入り、←→ で移る（選んでいるタブだけを止まり先にする）
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(id === state.currentId));
      button.setAttribute('aria-controls', 'memo');
      button.tabIndex = id === current ? 0 : -1;
      decorateTab(button, id);
      button.addEventListener('click', () => {
        select(id);
        focusEditor();
      });
      return button;
    }),
  );
  if (focusedId) tabButton(focusedId)?.focus();
  // タブが何行にもなってスクロールしているときも、選んでいるタブを見える位置に出す
  el.tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

const tabButton = (id) => el.tabs.querySelector(`.tab[data-id="${id}"]`);
const groupChipButton = (name) => [...el.groups.querySelectorAll('.group-chip')].find((chip) => chip.dataset.group === name);

// 選んでいるグループのチップに付ける ▾（メニューを開く）。キーでは Shift+F10 で開くので、読み上げからは外す
function moreButton(title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'more-button';
  button.title = title;
  button.tabIndex = -1;
  button.setAttribute('aria-hidden', 'true');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  const path = document.createElementNS(ns, 'path');
  for (const [name, value] of Object.entries({ d: 'M2 3.5 5 6.5 8 3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
    path.setAttribute(name, value);
  }
  svg.append(path);
  button.append(svg);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

// グループの色。自分で選んでいなければ、並んでいる順に割り当てる（lib/group-colors.js）
function groupColor(name) {
  return GROUP_COLORS[state.colorMap[name]]?.hex ?? GROUP_COLORS.gray.hex;
}

async function loadGroupColors() {
  try {
    state.groupColors = await readGroupColors(chrome.storage.sync);
  } catch {
    state.groupColors = {};
  }
  renderTabs();
}

async function saveGroupColors(colors) {
  state.groupColors = colors;
  renderTabs();
  try {
    await chrome.storage.sync.set({ [GROUP_COLOR_KEY]: colors });
  } catch (error) {
    showNotice(errorText(error, 'グループの色を保存できませんでした。'), 'error');
  }
}

// タブの上に「すべて」と各グループを並べ、右端に「＋ グループ」を置く（グループが無いときはボタンだけ）
function renderGroups() {
  const names = state.groups;
  el.groups.hidden = false;
  // 作り直してもキー操作の場所が外れないように、選んでいたグループを覚えておく（「すべて」は空の名前）
  const active = el.groups.contains(document.activeElement) ? document.activeElement : null;
  const focused = active?.classList.contains('group-chip') ? (active.dataset.group ?? '') : null;
  const count = (name) => state.visible.filter((id) => state.doc.memos[id].group === name).length;
  const chips = names.length ? [groupChip(null, 'すべて', state.visible.length), ...names.map((name) => groupChip(name, name, count(name)))] : [];
  el.groups.replaceChildren(...chips, addGroupButton());
  if (focused === '') el.groups.querySelector('.group-chip:not([data-group])')?.focus();
  else if (focused) groupChipButton(focused)?.focus();
  else if (active?.classList.contains('group-add')) el.groups.querySelector('.group-add')?.focus();
}

function addGroupButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'group-add';
  button.textContent = '＋ グループ';
  button.title = '新しいグループを作る';
  button.addEventListener('click', () => newGroupInline(button));
  return button;
}

// 「＋ グループ」の場所で名前を書いて、新しいグループを作る（createGroup）
function newGroupInline(button) {
  const id = state.currentId;
  const grouped = !!state.doc.memos[id]?.group;
  menu.close({ focus: false });
  state.inlineEditing = true;
  editInline(button, {
    placeholder: '例：仕事',
    maxLength: MAX_GROUP_LENGTH,
    label: grouped ? '新しいグループの名前。決めると、新しいメモがそのグループにできます' : `新しいグループの名前。決めるとメモ ${state.visible.indexOf(id) + 1} が入ります`,
    onCommit: (value) => {
      const name = cleanLabel(value, MAX_GROUP_LENGTH);
      if (name) createGroup(id, name);
    },
    onEnd: () => {
      endInlineEdit();
      return el.groups.querySelector('.group-add');
    },
  });
}

// グループに入っていない表示中のメモは、新しいグループに入れる。
// 別のグループに入っているメモは動かさず、新しいメモを作って入れる（メモが 1 つだけのグループが消えないように）
async function createGroup(id, name) {
  const memo = state.doc.memos[id];
  if (!memo) return;
  if (!memo.group) {
    moveToGroup(id, name);
    return;
  }
  if (state.groups.includes(name)) {
    setGroup(name);
    showNotice(`グループ「${name}」はもうあります`);
    return;
  }
  try {
    const created = await send('add', { group: name });
    await readStorage();
    state.group = name;
    select(created);
    showEditor();
    el.memo.focus();
    showNotice(`グループ「${name}」を作りました`);
  } catch (error) {
    showNotice(errorText(error), 'error');
  }
}

function groupChip(group, label, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'group-chip';
  button.setAttribute('aria-pressed', String(state.group === group));
  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = label;
  const number = document.createElement('span');
  number.className = 'group-count';
  number.textContent = String(count);
  button.append(name, number);
  button.addEventListener('click', () => setGroup(group));
  // タブをここに落とすと、このグループに入る。「すべて」に落とすとグループから外れる
  button.addEventListener('dragover', (event) => {
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    button.classList.add('drop-target');
  });
  button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
  button.addEventListener('drop', (event) => {
    if (!draggingId) return;
    event.preventDefault();
    button.classList.remove('drop-target');
    moveToGroup(draggingId, group ?? '');
  });
  if (!group) {
    button.title = 'すべてのメモを出す\nタブをここにドラッグすると、グループから外れます';
    return button;
  }
  button.dataset.group = group;
  button.classList.add('has-color');
  button.style.setProperty('--group-color', groupColor(group));
  button.title = `「${group}」のメモだけを出す\nダブルクリック：名前を変える\n右クリックか ▾：メモを入れる・外す、名前や色を変える、グループをやめる\nタブをここにドラッグすると、このグループに入ります`;
  button.setAttribute('aria-label', `グループ「${group}」のメモ ${count} 件だけを出す`);
  button.setAttribute('aria-description', 'Shift+F10 でメニューを開く。表示中のメモを入れる・外す、名前や色を変える');
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openGroupMenu(group);
  });
  button.addEventListener('keydown', (event) => {
    if (!isMenuKey(event)) return;
    event.preventDefault();
    openGroupMenu(group);
  });
  if (state.group !== group) return button;
  const split = document.createElement('span');
  split.className = 'chip-split';
  split.append(button, moreButton('メモを入れる・外す、名前や色を変える、グループをやめる', () => openGroupMenu(group, split)));
  return split;
}

function setGroup(group) {
  if (state.group === group) return;
  state.group = group;
  const shown = shownIds();
  if (shown.includes(state.currentId)) {
    saveUi();
    renderTabs();
  } else {
    select(shown[0], { force: true });
  }
}

const TAB_HINT = 'ドラッグか Alt+←→：並べ替え ／ 上のグループにドラッグ：グループに入れる';

// 番号と、設定で選んだときは 1 行目。隠しているメモは 1 行目を出さない
function decorateTab(button, id) {
  const memo = state.doc.memos[id];
  const line = memo.hidden ? '' : firstLine(memo.text);
  const images = memoImageIds(state.doc, id).length;
  const label = state.prefs.tabLabel === 'title' ? line : '';
  const number = state.visible.indexOf(id) + 1;
  // パスワードや個人情報らしい文字があるメモ（隠しているメモには付けない）
  const flagged = !memo.hidden && sensitive.findingsOf(memo.text).length > 0;
  const what = memo.hidden ? '隠しているメモ' : line ? line.slice(0, 60) : images ? `画像 ${images} 枚` : '空のメモ';
  button.title = [what, memo.group ? `グループ：${memo.group}` : '', flagged ? '要注意の文字があります' : '', TAB_HINT].filter(Boolean).join('\n');
  // 読み上げでは、番号のほかに 1 行目・グループ・隠しているか・要注意かも伝える
  const spoken = [
    `メモ ${number}`,
    line ? line.slice(0, 30) : '',
    memo.group ? `グループ「${memo.group}」` : '',
    memo.hidden ? '隠しています' : '',
    flagged ? '要注意の文字があります' : '',
  ];
  button.setAttribute('aria-label', spoken.filter(Boolean).join('・'));
  button.classList.toggle('has-text', memo.text.trim() !== '' || images > 0);
  button.classList.toggle('is-hidden', !!memo.hidden);
  button.classList.toggle('has-sensitive', flagged);
  // 「すべて」を出しているときは、グループの色の線をタブの下に引く
  const color = !state.group && memo.group ? groupColor(memo.group) : null;
  button.classList.toggle('in-group', !!color);
  if (color) button.style.setProperty('--group-color', color);
  else button.style.removeProperty('--group-color');
  const numberText = document.createElement('span');
  numberText.textContent = String(number);
  const parts = [numberText];
  if (memo.hidden) parts.push(lockIcon());
  if (label) {
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = label.slice(0, 40);
    parts.push(name);
  }
  button.replaceChildren(...parts);
}

function lockIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'tab-lock');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(ns, 'rect');
  for (const [name, value] of Object.entries({ x: 3, y: 7, width: 10, height: 7.5, rx: 1.5, fill: 'currentColor' })) body.setAttribute(name, value);
  const shackle = document.createElementNS(ns, 'path');
  for (const [name, value] of Object.entries({ d: 'M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 })) {
    shackle.setAttribute(name, value);
  }
  svg.append(body, shackle);
  return svg;
}

function saveUi() {
  chrome.storage.local.set({ ui: { currentId: state.currentId, group: state.group } });
}

function select(id, { force = false } = {}) {
  if (id === state.currentId && !force) return;
  // 絞り込んでいるグループの外のメモ（ゴミ箱から戻したものなど）を開くときは、絞り込みを外す
  if (!shownIds().includes(id)) state.group = null;
  state.currentId = id;
  state.revealedId = null;
  saveUi();
  // 前のメモについての確認や欄は閉じる（別のメモで押してしまわないように）
  closeBar(el.confirmTabs);
  closeBar(el.confirmLinks);
  memoCopy.hide();
  menu.close({ focus: false });
  showCurrent();
  renderTabs();
}

function focusEditor() {
  if (isVeiled()) el.veilShow.focus();
  else if (state.preview) el.preview.focus();
  else el.memo.focus();
}

// 確認などの帯を閉じる。閉じたら true（returnTo にフォーカスを戻す）
function closeBar(box, returnTo = null) {
  if (box.hidden) return false;
  const hadFocus = box.contains(document.activeElement);
  box.hidden = true;
  if (returnTo && (hadFocus || document.activeElement === document.body)) returnTo.focus();
  return true;
}

// ---- タブの並べ替え（ドラッグ、または Alt + ←／→）とキー操作 ----

const TAB_TYPE = 'application/x-memo-sync-tab';
let draggingId = null;

function clearDropMarks({ keepDragging = false } = {}) {
  for (const tab of el.tabs.querySelectorAll('.tab')) {
    tab.classList.remove('drop-before', 'drop-after');
    if (!keepDragging) tab.classList.remove('dragging');
  }
}

// ドラッグ中のタブを、どのタブの前（または後ろ）に入れるか
function dropTarget(event) {
  const tab = event.target.closest?.('.tab');
  if (!tab || !draggingId || tab.dataset.id === draggingId) return null;
  const rect = tab.getBoundingClientRect();
  return { tab, after: event.clientX > rect.left + rect.width / 2 };
}

// ids はタブに出しているメモの新しい並び。絞り込んでいるときは、出していないメモの位置は変えない
function applyOrder(shownOrder) {
  if (shownOrder.every((id, i) => id === state.shown[i])) return;
  const shown = new Set(state.shown);
  let index = 0;
  const ids = state.visible.map((id) => (shown.has(id) ? shownOrder[index++] : id));
  // 保存の返事を待たずに並べ替えて見せる（保存が届けば同じ並びになる）
  const visible = new Set(state.visible);
  let next = 0;
  state.doc = { ...state.doc, order: state.doc.order.map((id) => (visible.has(id) ? ids[next++] : id)) };
  renderTabs();
  send('reorder', { ids }).catch(async (error) => {
    showNotice(errorText(error), 'error');
    await readStorage();
    renderTabs();
  });
}

el.tabs.addEventListener('dragstart', (event) => {
  const tab = event.target.closest?.('.tab');
  if (!tab) return;
  draggingId = tab.dataset.id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(TAB_TYPE, draggingId);
  tab.classList.add('dragging');
});

el.tabs.addEventListener('dragover', (event) => {
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearDropMarks({ keepDragging: true });
  target.tab.classList.add(target.after ? 'drop-after' : 'drop-before');
});

el.tabs.addEventListener('dragleave', (event) => {
  if (!el.tabs.contains(event.relatedTarget)) clearDropMarks({ keepDragging: true });
});

el.tabs.addEventListener('drop', (event) => {
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault();
  const ids = state.shown.filter((id) => id !== draggingId);
  ids.splice(ids.indexOf(target.tab.dataset.id) + (target.after ? 1 : 0), 0, draggingId);
  applyOrder(ids);
});

el.tabs.addEventListener('dragend', () => {
  draggingId = null;
  clearDropMarks();
});

// グループをダブルクリックすると名前を変える。1 回目のクリックでチップが作り直されても届くように、行で受ける
el.groups.addEventListener('dblclick', (event) => {
  const chip = event.target.closest?.('.group-chip[data-group]');
  if (chip) renameGroupInline(chip.dataset.group);
});

el.tabs.addEventListener('keydown', (event) => {
  const tab = event.target.closest?.('.tab');
  if (!tab) return;
  const ids = [...state.shown];
  const from = ids.indexOf(tab.dataset.id);
  // ←→ で隣のメモへ、Home・End で端のメモへ
  if (!event.altKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const steps = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: ids.length - 1 };
    const to = (steps[event.key] + ids.length) % ids.length;
    select(ids[to]);
    el.tabs.querySelector(`[data-id="${ids[to]}"]`)?.focus();
    return;
  }
  // Alt + ←→ で並べ替え
  if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const id = tab.dataset.id;
  const to = from + (event.key === 'ArrowLeft' ? -1 : 1);
  if (to < 0 || to >= ids.length) return;
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  applyOrder(ids);
});

function moveToNeighbor() {
  const visible = visibleIds(state.doc);
  if (!visible.length) {
    send('add').catch((error) => showNotice(errorText(error), 'error'));
    return;
  }
  let shown = shownIds();
  if (!shown.length) {
    state.group = null;
    shown = visible;
  }
  const index = Math.max(0, state.shown.indexOf(state.currentId));
  select(shown[Math.min(index, shown.length - 1)], { force: true });
}

function showCurrent() {
  const memo = state.doc.memos[state.currentId];
  el.memo.value = memo && !memo.deleted ? memo.text : '';
  state.pendingExternal = false;
  updateLinks();
  updateCount();
  strip.render(state.doc, state.currentId, state.mode);
  renderVeil();
  refreshPreview();
}

// 他の端末（または別の画面）で変わった内容を入力欄に映す。
// 書いている最中は、変わったところだけを差し替える（入力欄の「元に戻す」の記録を消さないため）
function applyExternal() {
  const memo = state.doc.memos[state.currentId];
  if (!memo || memo.deleted || memo.text === el.memo.value || state.sent.includes(memo.text)) return;
  if (state.composing) {
    state.pendingExternal = true;
    return;
  }
  replaceEditorText(memo.text);
}

// 入力欄の文字を next にする。書いている最中は変わったところだけを差し替え、カーソルとスクロールを保つ
function replaceEditorText(next) {
  const old = el.memo.value;
  const { selectionStart, selectionEnd, scrollTop } = el.memo;
  if (document.activeElement === el.memo) {
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let tail = 0;
    while (tail < old.length - start && tail < next.length - start && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    state.applyingExternal = true;
    el.memo.setSelectionRange(start, old.length - tail);
    const ok = document.execCommand('insertText', false, next.slice(start, next.length - tail));
    state.applyingExternal = false;
    if (!ok || el.memo.value !== next) el.memo.value = next;
    // 変わったところより後ろのカーソルは、増えた（減った）分だけずらす
    const delta = next.length - old.length;
    const shift = (pos) => (pos <= start ? pos : pos >= old.length - tail ? pos + delta : start);
    el.memo.setSelectionRange(shift(selectionStart), shift(selectionEnd));
  } else {
    el.memo.value = next;
    el.memo.setSelectionRange(Math.min(selectionStart, next.length), Math.min(selectionEnd, next.length));
  }
  el.memo.scrollTop = scrollTop;
  updateLinks();
  updateCount();
  sensitive.schedule();
  refreshPreview();
}

// ---- 検索の結果を開く ----

function openResult({ id, start, end }) {
  if (!visibleIds(state.doc).includes(id)) return;
  showEditor();
  select(id, { force: true });
  el.memo.focus();
  el.memo.setSelectionRange(start, end);
  scrollToOffset(start);
}

// 本文の offset 文字目が入力欄の上のほうに見えるようにスクロールする。
// 同じ幅・同じ文字の見えない箱に手前までの本文を入れて、高さを測る
function scrollToOffset(offset) {
  const style = getComputedStyle(el.memo);
  const mirror = document.createElement('div');
  for (const name of ['boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize']) {
    mirror.style[name] = style[name];
  }
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '-10000px',
    visibility: 'hidden',
    width: `${el.memo.clientWidth}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  mirror.textContent = el.memo.value.slice(0, offset);
  document.body.append(mirror);
  const top = mirror.scrollHeight;
  mirror.remove();
  el.memo.scrollTop = Math.max(0, top - el.memo.clientHeight / 3);
}

// Chrome 同期の残り（日本語ならおよそ何文字か。1 文字 3 バイトとして数える）
function syncRoom() {
  if (state.mode !== 'chrome' || !state.syncUsage) return null;
  const { bytes, quota } = state.syncUsage;
  return { ratio: bytes / quota, chars: Math.max(0, Math.floor((quota * 0.98 - bytes) / 3)) };
}

// 改行を除いた文字数。文字を選んでいるときは、選んだ分も出す。
// Chrome 同期の容量が残り少ないときは、残りの文字数も出す
function updateCount() {
  const chars = (text) => [...text.replace(/\n/g, '')].length;
  const { value, selectionStart, selectionEnd } = el.memo;
  const total = chars(value);
  const selected = document.activeElement === el.memo && selectionEnd > selectionStart ? chars(value.slice(selectionStart, selectionEnd)) : 0;
  const room = syncRoom();
  const left = room && room.ratio >= 0.7 ? `・残り約 ${room.chars.toLocaleString()} 字` : '';
  el.count.textContent = (selected ? `${selected.toLocaleString()} / ${total.toLocaleString()} 文字` : `${total.toLocaleString()} 文字`) + left;
  const base = selected ? '選んだ文字数 / 全体の文字数。改行は数えません' : '文字数。改行は数えません';
  el.count.title = room ? `${base}。Chrome 同期の残りは、すべてのメモ合わせて約 ${room.chars.toLocaleString()} 字です` : base;
}

function updateLinks() {
  const links = extractLinks(el.memo.value);
  state.links = links;
  el.links.hidden = links.length === 0;
  el.openLinks.textContent = `${links.length} 件をすべて開く`;
  const items = links.slice(0, LINKS_SHOWN).map((href) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = href;
    link.textContent = linkLabel(href);
    link.title = href;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: href });
    });
    item.append(link);
    return item;
  });
  if (links.length > LINKS_SHOWN) {
    const more = document.createElement('li');
    more.className = 'link-more';
    more.textContent = `ほか ${links.length - LINKS_SHOWN} 件`;
    items.push(more);
  }
  el.linkList.replaceChildren(...items);
}

let statusTimer;
function renderStatus(status) {
  clearTimeout(statusTimer);
  // 同期は数百ミリ秒で終わることが多いので、「同期中」はすぐには出さない。
  // 同期中の間は、前の失敗の帯もそのまま残す（1 分ごとにやり直すたびに出たり消えたりしないように）
  if (status?.state === 'syncing') {
    if (state.statusShown) statusTimer = setTimeout(() => paintStatus(status), 700);
    else paintStatus(status);
    return;
  }
  const wasOk = state.status?.state !== 'ok';
  paintStatus(status);
  renderProblem(status);
  if (status?.state === 'ok' && (wasOk || state.mode === 'chrome')) checkSyncUsage();
}

function paintStatus(status) {
  state.status = status;
  const { tone, text, title } = describeStatus(status);
  el.status.className = `status status-button ${tone}`;
  el.status.textContent = text;
  const pending = state.dirty ? 'この PC にだけある編集があり、次の同期で送ります。' : '';
  const sentence = title && !/[。）]$/.test(title) ? `${title}。` : title;
  el.status.title = `${sentence}${pending}押すと設定を開きます`;
  el.status.setAttribute('aria-label', `${text}。${pending}設定を開く`);
  state.statusShown = true;
}

// 同期に失敗している間は、上に帯を出して、理由と次にすることを見せる
function renderProblem(status) {
  const problem = describeProblem(status);
  const key = problem ? `${status.state}:${status.kind}:${status.message}` : null;
  if (!problem || state.problemDismissed === key) {
    notices.removeBanner('sync');
    return;
  }
  const action = {
    connect: { label: 'ドライブに接続し直す', primary: true, run: () => openSettings('sync-title') },
    settings: { label: '設定を開く', primary: true, run: () => openSettings('sync-title') },
    retry: { label: 'もう一度同期', primary: true, run: () => send('sync').catch(() => {}) },
  }[problem.action];
  notices.banner('sync', {
    tone: 'danger',
    text: problem.text,
    actions: [action],
    closable: true,
    onClose: () => {
      state.problemDismissed = key;
    },
  });
}

// Chrome 同期の使用量が 70%・90% を超えたら知らせる（いっぱいになると、すべてのメモの同期が止まるため）
async function checkSyncUsage() {
  if (state.mode !== 'chrome') {
    state.syncUsage = null;
    notices.removeBanner('quota');
    updateCount();
    return;
  }
  try {
    const bytes = await chrome.storage.sync.getBytesInUse(null);
    state.syncUsage = { bytes, quota: chrome.storage.sync.QUOTA_BYTES ?? 102_400 };
  } catch {
    return;
  }
  updateCount();
  const { ratio } = syncRoom();
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : null;
  if (!level || state.quotaDismissed === level || (state.quotaDismissed === 'danger' && level === 'warn')) {
    if (!level) notices.removeBanner('quota');
    return;
  }
  const used = `${(state.syncUsage.bytes / 1024).toFixed(1)}KB / ${Math.round(state.syncUsage.quota / 1024)}KB`;
  notices.banner('quota', {
    tone: level,
    text: `Chrome 同期の容量を ${Math.round(ratio * 100)}% 使っています。使用量は ${used} です。いっぱいになると、すべてのメモの同期が止まります。メモを短くするか、Google ドライブ同期に切り替えてください。`,
    actions: [{ label: '設定を開く', run: () => openSettings('sync-title') }],
    closable: true,
    onClose: () => {
      state.quotaDismissed = level;
    },
  });
}

// 右クリックで送ったときの失敗（バックグラウンドが覚えておいたもの）
function renderDeliveryError(error) {
  if (!error?.message) {
    notices.removeBanner('delivery');
    return;
  }
  notices.banner('delivery', {
    tone: 'danger',
    text: `${formatWhen(error.at)} に「右クリックで送る」が失敗しました。${error.message}`,
    closable: true,
    onClose: () => chrome.storage.local.remove('deliveryError'),
  });
}

// はじめて入れたときだけ出す案内（「閉じる」で消す）
function renderOnboarding(show) {
  if (!show) {
    notices.removeBanner('welcome');
    return;
  }
  const { open } = state.shortcuts;
  const lines = [
    `${APP_NAME}へようこそ。今の同期の方式は「${MODE_LABELS[state.mode]}」です。ほかの PC と同じ方式を選んでください。方式が違うと、メモが届きません。`,
    state.mode === 'chrome' ? 'Chrome の同期と、同期する項目の「拡張機能」をオンにしてください。' : '',
    `${open ? `${open} で開けます。` : ''}ページで選んだ文字は、右クリックでメモに送れます。サイドパネルで横に出しておくこともできます。`,
  ].filter(Boolean);
  const actions = [{ label: '同期の方式を選ぶ', primary: true, run: () => openSettings('sync-title') }];
  if (state.mode === 'chrome') actions.push({ label: 'Chrome の同期設定を開く', run: () => chrome.tabs.create({ url: 'chrome://settings/syncSetup' }) });
  notices.banner('welcome', { tone: 'info', text: lines, actions, closable: true, onClose: () => chrome.storage.local.remove('onboarding') });
}

// 削除のすぐ後だけ「元に戻す」を出す（あとからは設定画面のゴミ箱から戻せる）
function offerUndo(trashId, message) {
  if (!trashId) {
    showNotice(message);
    return;
  }
  showNotice(message, 'info', { action: { label: '元に戻す', run: () => undo(trashId) }, duration: UNDO_FOR });
}

// 印を付けて保存した直後だけ「元に戻す」を出す（印を付ける前の画像に、同じ位置で戻す）
function offerRevert(imageId, trashId) {
  if (!trashId) {
    showNotice('印を付けた画像にしました');
    return;
  }
  const run = async () => {
    try {
      await send('revertImage', { id: imageId, trashId });
      showNotice('印を付ける前の画像に戻しました');
    } catch (error) {
      showNotice(errorText(error), 'error');
    }
  };
  showNotice('印を付けた画像にしました。元の画像はゴミ箱にあります', 'info', { action: { label: '元に戻す', run }, duration: UNDO_FOR });
}

async function undo(trashId) {
  try {
    const { memoId } = await send('restoreTrash', { id: trashId });
    await readStorage();
    select(memoId, { force: true });
    focusEditor();
    showNotice('元に戻しました');
  } catch (error) {
    showNotice(errorText(error), 'error');
  }
}

// メモを開くショートカットキーを、はじめての案内に出しておく
async function showShortcuts() {
  const commands = await chrome.commands.getAll();
  state.shortcuts = { open: commands.find((command) => command.name === '_execute_action')?.shortcut ?? '' };
}

// 別の PC の編集で置き換わったメモがあったときのお知らせ（閉じるまで残す）
let alertTarget = 'conflict';
function renderAlert(alert) {
  if (alert?.kind !== 'conflict') {
    closeBar(el.alert, el.memo);
    return;
  }
  const titles = (alert.titles ?? []).map((title) => `「${title || '空のメモ'}」`);
  const names = titles.length > 2 ? `${titles.slice(0, 2).join('、')} ほか ${titles.length - 2} 件` : titles.join('、');
  el.alertText.textContent = `別の PC での編集と重なったため、${names}は後から編集された方の内容になりました。もう一方の内容はバックアップに残っていて、新しいメモとして取り戻せます。`;
  alertTarget = alert.backupAt ? `conflict-${alert.backupAt}` : 'conflict';
  el.alert.hidden = false;
}

function dismissAlert() {
  chrome.storage.local.remove('alert');
  closeBar(el.alert, el.memo);
}

// ---- 入力と操作 ----

function onInput() {
  // 他の端末の内容を映しているだけのときは、保存し直さない
  if (state.applyingExternal) return;
  const id = state.currentId;
  const text = el.memo.value;
  const at = Math.max(Date.now(), state.lastEditAt + 1);
  state.lastEditAt = at;
  const memo = { ...state.doc.memos[id], text, updatedAt: at };
  state.values[memoKey(id)] = memo;
  state.doc.memos[id] = memo;
  state.sent = [text, ...state.sent.slice(0, 4)];
  send('edit', { id, text, at }).catch((error) => showNotice(errorText(error, '保存できませんでした。'), 'error'));
  // 上限で切れたとき（貼り付けた長い文の後ろが入らなかったときなど）は知らせる
  if (text.length >= MAX_TEXT_LENGTH) {
    showNotice(`1 つのメモは ${MAX_TEXT_LENGTH.toLocaleString()} 文字までです。それより後ろは入りません`, 'error');
  }
  updateLinks();
  updateCount();
  sensitive.schedule();
  const button = el.tabs.querySelector(`[data-id="${id}"]`);
  if (button) decorateTab(button, id);
}

// ---- 置換 ----

// 表示中でないメモも含めて、本文を書き換えて保存する（入力したときと同じ流れ）
function setMemoText(id, text) {
  const memo = state.doc.memos[id];
  if (!memo || memo.deleted) return;
  const at = Math.max(Date.now(), state.lastEditAt + 1);
  state.lastEditAt = at;
  const next = { ...memo, text, updatedAt: at };
  state.values[memoKey(id)] = next;
  state.doc.memos[id] = next;
  if (id === state.currentId) {
    if (el.memo.value !== text) replaceEditorText(text);
    state.sent = [text, ...state.sent.slice(0, 4)];
  }
  const button = el.tabs.querySelector(`[data-id="${id}"]`);
  if (button) decorateTab(button, id);
  send('edit', { id, text, at }).catch((error) => showNotice(errorText(error, '保存できませんでした。'), 'error'));
}

// 置き換えた本文を保存し、すぐ後だけ「元に戻す」を出す。長くなりすぎるメモは置き換えない
function applyReplace(changes) {
  const fits = changes.filter((change) => change.text.length <= MAX_TEXT_LENGTH);
  const tooLong = changes.length - fits.length;
  for (const change of fits) setMemoText(change.id, change.text);
  renderTabs();
  const count = fits.reduce((sum, change) => sum + change.count, 0);
  const skipped = tooLong ? `。${MAX_TEXT_LENGTH.toLocaleString()} 文字を超えるメモ ${tooLong} 件は置換していません` : '';
  if (!fits.length) {
    showNotice(`置換すると ${MAX_TEXT_LENGTH.toLocaleString()} 文字を超えるので、置換していません`, 'error');
    return;
  }
  const where = fits.length === 1 ? `メモ ${fits[0].number} で` : `メモ ${fits.length} 件で`;
  showNotice(`${where} ${count} か所を置換しました${skipped}`, 'info', {
    action: { label: '元に戻す', run: () => undoReplace(fits) },
    duration: UNDO_FOR,
  });
}

// 置換の後にまた書き換えたメモは、書いたものを消さないように戻さない
function undoReplace(changes) {
  let kept = 0;
  for (const change of changes) {
    const memo = state.doc.memos[change.id];
    if (memo?.text === change.text) setMemoText(change.id, change.previous);
    else kept++;
  }
  renderTabs();
  search.refresh();
  showNotice(kept ? `置換を元に戻しました。そのあと書き換えたメモ ${kept} 件はそのままです` : '置換を元に戻しました');
}

// ---- 書式を付けて表示 ----

function refreshPreview() {
  if (state.preview && !isVeiled()) preview.render();
}

// 編集と、書式を付けた表示を切り替える。focus が true なら、切り替えた先へフォーカスを移す
function setPreview(on, { focus = false } = {}) {
  state.preview = on;
  el.editor.classList.toggle('previewing', on);
  el.preview.hidden = !on;
  el.togglePreview.setAttribute('aria-pressed', String(on));
  refreshPreview();
  if (focus) focusEditor();
}

// 入力欄を使う操作（文字を入れる・見つけた場所を選ぶ）の前に、編集に戻す
function showEditor() {
  if (state.preview) setPreview(false);
}

// 表示の中のチェックボックスを押したとき。本文の [ ] と [x] を入れ替えて保存する
function onToggleTask(line) {
  const next = toggleTask(el.memo.value, line);
  if (next === null) refreshPreview();
  else setMemoText(state.currentId, next);
}

// ---- 名前・グループ ----

// 保存の返事を待たずに画面に映す（届いた保存が同じ内容で上書きする）
function setLocalLabel(id, changes) {
  const memo = state.doc.memos[id];
  if (!memo) return;
  const next = setLabel(memo, { ...labelFields(memo), ...changes }, Date.now());
  state.doc.memos[id] = next;
  state.values[memoKey(id)] = next;
}

function endInlineEdit() {
  state.inlineEditing = false;
  if (state.pendingRender) {
    state.pendingRender = false;
    renderTabs();
  }
}

// メモをグループに入れる（group が空ならグループから外す）。新しい名前なら、そのグループができる
function moveToGroup(id, group) {
  const memo = state.doc.memos[id];
  if (!memo || (memo.group ?? '') === group) return;
  const number = state.visible.indexOf(id) + 1;
  // 絞り込み中に、表示中のメモを別のグループへ移したときは、メモについていく
  const leaves = !!state.group && group !== state.group;
  if (leaves && id === state.currentId) state.group = group || null;
  setLocalLabel(id, { group });
  saveUi();
  renderTabs();
  send('label', { id, changes: { group } }).catch((error) => showNotice(errorText(error), 'error'));
  const text = group ? `メモ ${number} を「${group}」に入れました` : `メモ ${number} をグループから外しました`;
  // 絞り込んでいる画面から出ていったメモは、どこに行ったかを見に行けるようにする
  if (leaves && id !== state.currentId && group) showNotice(text, 'info', { action: { label: `「${group}」を見る`, run: () => setGroup(group) } });
  else showNotice(text);
}

// グループの ▾・右クリック・Shift+F10 で開くメニュー。表示中のメモを入れる・外す、色を選ぶ、名前を変える、グループをやめる。
// ドラッグできない人も、ここからメモをグループに出し入れできる
function openGroupMenu(name, anchor = null) {
  const chip = groupChipButton(name);
  if (!chip) return;
  const id = state.currentId;
  const number = state.visible.indexOf(id) + 1;
  const inGroup = state.doc.memos[id]?.group === name;
  menu.open(
    anchor ?? chip,
    [
      inGroup
        ? { type: 'item', label: `メモ ${number} をグループから外す`, onSelect: () => moveToGroup(id, '') }
        : { type: 'item', label: `メモ ${number} をこのグループに入れる`, onSelect: () => moveToGroup(id, name) },
      { type: 'separator' },
      {
        type: 'swatches',
        label: `グループ「${name}」の色`,
        options: Object.entries(GROUP_COLORS).map(([key, color]) => ({ key, label: color.label, hex: color.hex, checked: state.colorMap[name] === key })),
        onSelect: (key) => saveGroupColors({ ...state.groupColors, [name]: key }),
      },
      { type: 'separator' },
      { type: 'item', label: '名前を変える', onSelect: () => renameGroupInline(name) },
      { type: 'item', label: 'グループをやめる', onSelect: () => dissolveGroup(name) },
    ],
    { label: `グループ「${name}」のメニュー`, returnTo: chip },
  );
}

// グループのチップの場所で、名前を書き換える（▾ も隠して欄だけにする）
function renameGroupInline(name) {
  const chip = groupChipButton(name);
  if (!chip) return;
  let shown = name;
  menu.close({ focus: false });
  state.inlineEditing = true;
  editInline(chip.closest('.chip-split') ?? chip, {
    value: name,
    maxLength: MAX_GROUP_LENGTH,
    label: `グループ「${name}」の新しい名前`,
    onCommit: (value) => {
      const next = cleanLabel(value, MAX_GROUP_LENGTH);
      if (renameGroup(name, next)) shown = next;
    },
    onEnd: () => {
      endInlineEdit();
      return groupChipButton(shown);
    },
  });
}

// ほかのグループと同じ名前にはしない（2 つのグループが混ざらないように）。空のときも変えない
function renameGroup(from, to) {
  if (!to || to === from) return false;
  if (state.groups.includes(to)) {
    showNotice(`グループ「${to}」はもうあるので、名前は変えていません`);
    return false;
  }
  if (state.group === from) state.group = to;
  for (const id of visibleIds(state.doc)) {
    if (state.doc.memos[id].group === from) setLocalLabel(id, { group: to });
  }
  saveUi();
  if (state.groupColors[from]) saveGroupColors(renameGroupColor(state.groupColors, from, to));
  else renderTabs();
  send('renameGroup', { from, to })
    .then(() => showNotice(`グループの名前を「${to}」にしました`))
    .catch((error) => showNotice(errorText(error), 'error'));
  return true;
}

// グループをやめる。メモはそのまま「すべて」に残り、選んだ色の記録は消す。すぐ後だけ「元に戻す」を出す
async function dissolveGroup(name) {
  const ids = visibleIds(state.doc).filter((id) => state.doc.memos[id].group === name);
  if (!ids.length) return;
  const color = state.groupColors[name];
  if (state.group === name) state.group = null;
  for (const id of ids) setLocalLabel(id, { group: '' });
  saveUi();
  if (color) saveGroupColors(renameGroupColor(state.groupColors, name, ''));
  else renderTabs();
  try {
    await send('renameGroup', { from: name, to: '' });
  } catch (error) {
    showNotice(errorText(error), 'error');
    return;
  }
  showNotice(`グループ「${name}」をやめました。メモ ${ids.length} 件はそのまま残っています`, 'info', {
    action: { label: '元に戻す', run: () => restoreGroup(name, ids, color) },
    duration: UNDO_FOR,
  });
}

function restoreGroup(name, ids, color) {
  const alive = ids.filter((id) => state.visible.includes(id));
  for (const id of alive) setLocalLabel(id, { group: name });
  if (color) saveGroupColors({ ...state.groupColors, [name]: color });
  else renderTabs();
  for (const id of alive) send('label', { id, changes: { group: name } }).catch((error) => showNotice(errorText(error), 'error'));
  showNotice(`グループ「${name}」に戻しました`);
}

// ---- 隠す ----

function isVeiled(id = state.currentId) {
  return !!state.doc.memos[id]?.hidden && state.revealedId !== id;
}

function renderVeil() {
  const veiled = isVeiled();
  const hidden = !!state.doc.memos[state.currentId]?.hidden;
  el.editor.classList.toggle('veiled', veiled);
  el.veil.hidden = !veiled;
  el.toggleVeil.setAttribute('aria-pressed', String(veiled));
  const label = veiled ? '表示する' : hidden ? 'もう一度隠す' : 'このメモを隠す';
  el.toggleVeil.title = label;
  el.toggleVeil.setAttribute('aria-label', label);
  for (const control of [el.insertTime, el.insertUrl, el.togglePreview]) control.disabled = veiled;
  sensitive.refresh();
  refreshPreview();
}

function reveal() {
  state.revealedId = state.currentId;
  renderVeil();
  updateCount();
  focusEditor();
}

function veil() {
  state.revealedId = null;
  renderVeil();
  el.veilShow.focus();
}

// 「隠す」の印を付けて、すぐに隠す（ほかの PC でも隠れる）
function hideMemo(id) {
  setLocalLabel(id, { hidden: true });
  renderTabs();
  veil();
  showNotice('このメモを隠しました。次に開いたときも隠れています');
  send('label', { id, changes: { hidden: true } }).catch((error) => showNotice(errorText(error), 'error'));
}

// カーソルの位置に文字を入れる（選択中の文字は消さず、その前に入れる）
function insertText(text) {
  showEditor();
  el.memo.focus();
  const start = el.memo.selectionStart;
  el.memo.setSelectionRange(start, start);
  // execCommand は「元に戻す」が効く。使えないときだけ直接書き換える
  if (!document.execCommand('insertText', false, text)) {
    el.memo.setRangeText(text, start, start, 'end');
    onInput();
  }
}

// 押している間に同じボタンをもう一度押せないようにする（二度押しで 2 回動かないため）
async function whileBusy(button, fn) {
  if (button.dataset.busy) return;
  button.dataset.busy = '1';
  button.disabled = true;
  try {
    await fn();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    // 隠しているときやメモの数の上限など、もともと押せないボタンは押せないままにする
    renderTabs();
  }
}

async function insertCurrentUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      throw new Error(view === 'panel' ? 'URL を入れるには、タブを読み取る許可が必要です。' : 'このページの URL は読み取れませんでした。');
    }
    const title = tab.title?.trim();
    insertText(title && title !== tab.url ? `${title}\n${tab.url}\n` : `${tab.url}\n`);
  } catch (error) {
    showNotice(errorText(error), 'error');
  }
}

el.memo.addEventListener('input', onInput);
// 選んだ文字数を出すため
document.addEventListener('selectionchange', () => {
  if (document.activeElement === el.memo) updateCount();
});
for (const type of ['select', 'keyup', 'mouseup', 'blur']) el.memo.addEventListener(type, updateCount);

// ポップアップでは、入力欄の右下をドラッグして変えた高さを覚えておく（画像を貼っても変わらない）。
// ドラッグで変えると入力欄に直接高さが書かれるので、それを設定に移す
if (view === 'popup') {
  let heightTimer;
  new ResizeObserver(() => {
    if (!el.memo.style.height) return;
    clearTimeout(heightTimer);
    heightTimer = setTimeout(async () => {
      const height = Math.min(480, Math.max(120, Math.round(el.memo.offsetHeight)));
      document.documentElement.style.setProperty('--memo-height', `${height}px`);
      el.memo.style.removeProperty('height');
      const { prefs } = await chrome.storage.local.get('prefs');
      await chrome.storage.local.set({ prefs: { ...prefs, memoHeight: height } });
    }, 400);
  }).observe(el.memo);
}

// 置換は Windows などでは Ctrl+H。Mac の ⌘H はアプリを隠し、Ctrl+H は 1 文字消すので、⌘⇧H にする
const isMac = /Mac/.test(navigator.platform);
el.openSearch.title = `すべてのメモから探す ${isMac ? '⌘F' : 'Ctrl+F'}`;
$('replace-toggle').title = `置換後の文字の欄を出す ${isMac ? '⌘⇧H' : 'Ctrl+H'}`;
el.togglePreview.title = `書式を付けて表示 ${isMac ? '⌘E' : 'Ctrl+E'}`;
el.togglePreview.addEventListener('click', () => setPreview(!state.preview));
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  // 書式を付けた表示と編集を切り替える。探している間と、隠しているメモでは切り替えない
  if (key === 'e' && !event.shiftKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) {
    event.preventDefault();
    if (!search.isOpen() && !isVeiled()) setPreview(!state.preview, { focus: true });
    return;
  }
  const findKey = key === 'f' && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  const replaceKey = key === 'h' && (isMac ? event.metaKey && event.shiftKey : event.ctrlKey && !event.shiftKey && !event.metaKey);
  if (!findKey && !replaceKey) return;
  event.preventDefault();
  search.open({ replace: replaceKey });
});

// Esc で、出しているもの（確認・欄・帯）を手前から 1 つずつ閉じる
document.addEventListener('keydown', (event) => {
  // メニューを出しているときは、メニューが自分で閉じる
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || el.viewer.open || menu.isOpen()) return;
  const closers = [
    () => closeBar(el.confirmTabs, el.insertUrl),
    () => closeBar(el.confirmLinks, el.openLinks),
    () => memoCopy.hide(),
    () => sensitive.dismiss(),
    () => {
      if (!search.isOpen()) return false;
      search.close();
      return true;
    },
    () => {
      if (el.alert.hidden) return false;
      dismissAlert();
      return true;
    },
  ];
  if (closers.some((close) => close())) event.preventDefault();
});

el.alertOpen.addEventListener('click', () => {
  openSettings(alertTarget);
  dismissAlert();
});
el.alertClose.addEventListener('click', dismissAlert);
// 画像の貼り付けは、入力欄の外（タブのボタンなど）にいるときも受け付ける
document.addEventListener('paste', (event) => strip.onPaste(event));

el.toggleVeil.addEventListener('click', () => {
  const id = state.currentId;
  if (isVeiled()) return reveal();
  if (state.doc.memos[id]?.hidden) return veil();
  hideMemo(id);
});

el.veilShow.addEventListener('click', reveal);
el.veilOff.addEventListener('click', () => unhideMemo(state.currentId));

function unhideMemo(id) {
  setLocalLabel(id, { hidden: false });
  renderTabs();
  updateCount();
  focusEditor();
  send('label', { id, changes: { hidden: false } }).catch((error) => showNotice(errorText(error), 'error'));
}
// サイドパネルを閉じたり、ウィンドウを隠したりしたら、また隠す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.revealedId) {
    state.revealedId = null;
    renderVeil();
  }
});

// サイドパネルを開いたまま、アイコンかキーでポップアップを開いたとき（同じメモが 2 つ並ばないように閉じる）。
// 書いた文字は打つたびに保存しているので、ここで閉じても失われない
if (view === 'panel') {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'closePanel' && msg.windowId === state.windowId) window.close();
  });
}

strip.watchDrop(el.editor);
el.memo.addEventListener('compositionstart', () => {
  state.composing = true;
});
el.memo.addEventListener('compositionend', () => {
  state.composing = false;
  if (state.pendingExternal) {
    state.pendingExternal = false;
    applyExternal();
  }
});

el.insertTime.addEventListener('click', () => {
  insertText(`${formatTimestamp(new Date(), state.prefs.timeFormat)}\n`);
});

// サイドパネルではページを開き直すたびに activeTab の許可が切れるので、タブを読む許可を一度だけもらう。
// Chrome は「閲覧履歴の読み取り」と強く警告するので、求める前に何に使うかを説明する
el.insertUrl.addEventListener('click', () => {
  if (view === 'panel' && !state.canReadTabs) {
    el.confirmTabs.hidden = false;
    el.confirmTabsYes.focus();
    return;
  }
  insertCurrentUrl();
});
el.confirmTabsNo.addEventListener('click', () => closeBar(el.confirmTabs, el.insertUrl));
el.confirmTabsYes.addEventListener('click', async () => {
  closeBar(el.confirmTabs, el.insertUrl);
  state.canReadTabs = await chrome.permissions.request({ permissions: ['tabs'] });
  if (!state.canReadTabs) {
    showNotice('許可されなかったため、URL を入れられません', 'error');
    return;
  }
  insertCurrentUrl();
});

el.openLinks.addEventListener('click', () => {
  if (state.links.length > LINKS_CONFIRM) {
    el.confirmLinksText.textContent = `リンク ${state.links.length} 個を、新しいタブでまとめて開きます。`;
    el.confirmLinks.hidden = false;
    el.confirmLinksNo.focus();
    return;
  }
  for (const url of state.links) chrome.tabs.create({ url, active: false });
});
el.confirmLinksNo.addEventListener('click', () => closeBar(el.confirmLinks, el.openLinks));
el.confirmLinksYes.addEventListener('click', () => {
  closeBar(el.confirmLinks, el.openLinks);
  for (const url of state.links) chrome.tabs.create({ url, active: false });
});

el.add.addEventListener('click', () =>
  whileBusy(el.add, async () => {
    try {
      // グループで絞り込んでいるときは、そのグループに作る
      const id = await send('add', { group: state.group ?? undefined });
      await readStorage();
      select(id);
      // 新しいメモはすぐ書くので、書式を付けた表示から編集に戻す
      showEditor();
      el.memo.focus();
    } catch (error) {
      showNotice(errorText(error), 'error');
    }
  }),
);

el.remove.addEventListener('click', removeCurrent);

// 「－」：表示中のメモをすぐに削除する。確かめずに、お知らせで「元に戻す」を出す
// （設定画面のゴミ箱からも 30 日間戻せる。空のメモはゴミ箱に入れない）
async function removeCurrent() {
  if (state.visible.length <= MIN_MEMOS) return;
  const id = state.currentId;
  const number = state.visible.indexOf(id) + 1;
  state.removingId = id;
  try {
    const { trashId } = await send('remove', { id });
    offerUndo(trashId, trashId ? `メモ ${number} を削除しました。設定画面の「ゴミ箱」から 30 日間戻せます` : `空のメモ ${number} を削除しました`);
  } catch (error) {
    showNotice(errorText(error), 'error');
  } finally {
    focusEditor();
  }
}

// 「サイドパネルで開く」と「ポップアップに戻す」。どちらも、開いた先が元の画面を閉じる形にする
el.switchView.addEventListener('click', () => {
  // ボタンを押した直後でないと開けないので、待たずに呼ぶ
  if (view === 'popup') {
    chrome.sidePanel
      .open({ windowId: state.windowId })
      .then(() => window.close())
      .catch((error) => showNotice(errorText(error, 'サイドパネルを開けませんでした。'), 'error'));
    return;
  }
  // アイコンでサイドパネルを開く設定のときは、ポップアップを外してあるので付け直す。
  // 開いたポップアップが、このサイドパネルを閉じ、ポップアップを設定どおりに外し直す
  const detached = state.prefs.openIn === 'panel';
  if (detached) chrome.action.setPopup({ popup: 'ui/popup.html' });
  let opening;
  try {
    opening = chrome.action.openPopup({ windowId: state.windowId });
  } catch (error) {
    opening = Promise.reject(error);
  }
  opening.catch((error) => {
    console.warn(error);
    if (detached) chrome.action.setPopup({ popup: '' });
    showNotice(
      detached
        ? 'ポップアップを開けませんでした。設定画面の「アイコンを押したとき」をポップアップにすると、アイコンから開けます。'
        : 'ポップアップを開けませんでした。ツールバーのアイコンを押すと開けます。',
      'error',
    );
  });
});

for (const button of [el.status, el.openOptions]) {
  button.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init().catch((error) => {
  notices.banner('load', {
    tone: 'danger',
    text: errorText(error, '読み込めませんでした。'),
    actions: [{ label: 'もう一度読む', primary: true, run: () => location.reload() }],
  });
});

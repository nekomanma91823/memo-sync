// 設定画面の「バックアップ」：一覧・中身を見る・1 つのメモだけ戻す・この状態に戻す・書き出す。
//
// 別の PC の編集と重なったときのバックアップには、重なったメモの ID（conflicts）が入っている。
// メモの画面のお知らせからは #conflict-<バックアップの時刻> で開くので、そのバックアップを開いて、
// 重なったメモ（負けた方の内容）を先に見せる。

import { visibleIds } from '../lib/model.js';
import { readLocalDoc } from '../lib/local-doc.js';
import { backupFileName, exportText } from '../lib/backup-format.js';
import { backupMemoRows, restoreSummary } from '../lib/settings-checks.js';
import { formatDateTime } from '../lib/time-format.js';
import { downloadText, firstLine, send } from './common.js';
import { confirmInline, focusInList, foldList, makeButton, setMessage, showError } from './options-ui.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_CHARS = 400;
const BACKUP_REASONS = {
  sync: '同期でメモが大きく変わる前',
  remove: 'メモを削除する前',
  import: '取り込みの前',
  restore: '復元の前',
  conflict: '別の PC の編集と重なったとき',
  mode: '同期方式を切り替える前',
  auto: '1 時間ごとの自動',
};

function backupDoc(backup) {
  return {
    order: backup.memos.map((memo) => memo.id),
    orderUpdatedAt: 0,
    memos: Object.fromEntries(backup.memos.map((memo) => [memo.id, { text: memo.text, updatedAt: 0 }])),
  };
}

// 今のメモの中での番号（無ければ 0）
async function currentNumber(id) {
  const doc = await readLocalDoc(chrome.storage.local);
  return visibleIds(doc).indexOf(id) + 1;
}

export function setupBackups() {
  const list = $('backup-list');
  const more = $('backup-more');
  const opened = new Set(); // 中身を開いているバックアップの at
  let showAll = false;
  let focusAfter = null; // 作り直したあとにキー操作の場所を戻す先 { at: バックアップ, button: 何番目のボタンか }
  let backups = [];

  // ---- 1 つのメモ ----

  function memoRow(backup, { memo, number, conflicted }) {
    const li = document.createElement('li');
    li.className = `backup-memo${conflicted ? ' conflicted' : ''}`;
    const head = document.createElement('div');
    head.className = 'backup-memo-head';
    const title = document.createElement('strong');
    const hidden = memo.label?.hidden === true;
    const name = hidden ? '' : firstLine(memo.text).slice(0, 40);
    title.textContent = `メモ ${number}${name ? `「${name}」` : ''}`;
    head.append(title);
    if (conflicted) {
      const mark = document.createElement('span');
      mark.className = 'badge warn';
      mark.textContent = '別の PC の編集で置き換わった内容';
      head.append(mark);
    }
    const chars = document.createElement('span');
    chars.className = 'hint-inline';
    chars.textContent = `${[...memo.text].length.toLocaleString()} 文字`;
    head.append(chars);

    // 隠していたメモは、「表示する」を押すまで本文を出さない
    const preview = document.createElement('pre');
    preview.className = 'memo-preview';
    const showText = () => {
      const text = memo.text.length > PREVIEW_CHARS ? `${memo.text.slice(0, PREVIEW_CHARS)}…` : memo.text;
      preview.textContent = text || '空のメモ';
    };
    const actions = document.createElement('div');
    actions.className = 'buttons';
    if (hidden) {
      preview.textContent = '隠していたメモです。';
      const reveal = makeButton('表示する');
      reveal.addEventListener('click', () => {
        showText();
        reveal.remove();
        copy.focus();
      });
      actions.append(reveal);
    } else {
      showText();
    }

    const copy = makeButton('コピー');
    copy.disabled = !memo.text;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(memo.text);
        setMessage('backup-message', `${formatDateTime(backup.at)} のメモ ${number} の内容をコピーしました。`, 'ok');
      } catch (error) {
        showError('backup-message', error, 'コピーできませんでした。');
      }
    });

    const restore = makeButton('新しいメモとして戻す');
    restore.disabled = !memo.text.trim();
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        const { memoId } = await send('restoreBackupMemo', { at: backup.at, id: memo.id });
        const now = await currentNumber(memoId);
        setMessage('backup-message', `このときのメモ ${number} を、新しいメモ ${now} として戻しました。ほかのメモはそのままです。`, 'ok');
      } catch (error) {
        showError('backup-message', error, '戻せませんでした。');
      }
      restore.disabled = !memo.text.trim();
      restore.focus();
    });
    actions.append(copy, restore);

    li.append(head, preview, actions);
    if (conflicted) {
      currentNumber(memo.id).then((now) => {
        if (!now) return;
        const note = document.createElement('p');
        note.className = 'hint-inline';
        note.textContent = `今の内容は、メモ ${now} にあります。`;
        head.after(note);
      });
    }
    return li;
  }

  function memoList(backup) {
    const box = document.createElement('div');
    box.className = 'backup-memos';
    box.id = `backup-memos-${backup.at}`;
    const rows = backupMemoRows(backup);
    if (backup.conflicts?.length) {
      const note = document.createElement('p');
      note.className = 'hint-inline';
      note.textContent = `重なったメモ ${backup.conflicts.length} 件を先に並べています。中身は、置き換わる前の内容です。`;
      box.append(note);
    }
    const ul = document.createElement('ul');
    ul.className = 'backup-memo-list';
    ul.append(...rows.map((row) => memoRow(backup, row)));
    box.append(ul);
    return box;
  }

  // ---- この状態に戻す ----

  async function showRestoreConfirm(item, backup, button) {
    const doc = await readLocalDoc(chrome.storage.local);
    const { memos, changed, removed, removedImages } = restoreSummary(backup, doc);
    const lines = [`今のメモを、${formatDateTime(backup.at)} のバックアップにあるメモ ${memos} 件に置き換えます。`];
    lines.push(changed ? `中身が変わるメモは ${changed} 件です。` : '中身が変わるメモはありません。');
    if (removed) {
      lines.push(`このバックアップの後に作ったメモ ${removed} 件${removedImages ? `と、貼った画像 ${removedImages} 枚` : ''}はゴミ箱に移り、30 日間は戻せます。`);
    }
    lines.push('ほかの PC にも伝わります。今の状態もバックアップに残ります。');
    confirmInline(item, {
      text: lines.join(''),
      yesLabel: '戻す',
      returnFocus: button,
      onYes: async () => {
        // 戻すと一覧が作り直されるので、先にボタンへ戻しておく（作り直したあとも同じボタンに戻る）
        button.focus();
        try {
          const { count } = await send('restore', { at: backup.at });
          setMessage('backup-message', `${formatDateTime(backup.at)} の状態に戻しました。メモは ${count} 件です。`, 'ok');
        } catch (error) {
          showError('backup-message', error, '戻せませんでした。');
        }
      },
    });
  }

  // ---- 1 件のバックアップ ----

  function backupItem(backup) {
    const item = document.createElement('li');
    item.className = 'backup-item';
    item.id = `backup-${backup.at}`;
    item.dataset.at = String(backup.at);

    const info = document.createElement('div');
    info.className = 'backup-info';
    const when = document.createElement('strong');
    when.textContent = formatDateTime(backup.at);
    const what = document.createElement('span');
    what.textContent = `${BACKUP_REASONS[backup.reason] ?? 'その他'}・メモ ${backup.memos.length} 件`;
    info.append(when, what);
    if (backup.conflicts?.length) {
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = `重なったメモ ${backup.conflicts.length} 件`;
      info.append(badge);
    }
    const preview = document.createElement('span');
    preview.className = 'preview';
    // 隠しているメモは、本文の 1 行目を出さない
    preview.textContent = backup.memos
      .map((memo) => (memo.label?.hidden ? '' : firstLine(memo.text)))
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ');
    info.append(preview);

    const isOpen = opened.has(backup.at);
    const view = makeButton(isOpen ? '中身を閉じる' : '中身を見る');
    view.setAttribute('aria-expanded', String(isOpen));
    view.setAttribute('aria-controls', `backup-memos-${backup.at}`);
    view.addEventListener('click', () => {
      if (opened.has(backup.at)) opened.delete(backup.at);
      else opened.add(backup.at);
      focusAfter = { at: backup.at, button: 0 };
      render();
    });

    const exportButton = makeButton('書き出す');
    exportButton.addEventListener('click', () => {
      downloadText(backupFileName(new Date(backup.at)), exportText(backupDoc(backup)));
      setMessage('backup-message', `${formatDateTime(backup.at)} のバックアップを .txt に書き出しました。`, 'ok');
    });

    const restoreButton = makeButton('この状態に戻す');
    restoreButton.addEventListener('click', () => showRestoreConfirm(item, backup, restoreButton));

    item.append(info, view, exportButton, restoreButton);
    if (isOpen) item.append(memoList(backup));
    return item;
  }

  function render() {
    const nodes = backups.map(backupItem);
    foldList(list, nodes, more, { open: showAll });
    $('backup-empty').hidden = backups.length > 0;
    if (focusAfter) {
      const target = [...list.children].find((item) => item.dataset.at === String(focusAfter.at));
      target?.querySelectorAll(':scope > button')[focusAfter.button]?.focus();
      focusAfter = null;
    }
  }

  async function load() {
    ({ backups = [] } = await chrome.storage.local.get('backups'));
    render();
  }

  more.addEventListener('click', () => {
    showAll = true;
    render();
    focusInList(list, 5, $('backup-title'));
  });

  // #conflict-<at>（無ければ #conflict）：重なったときのバックアップを開いて見せる
  async function openFromHash() {
    const match = location.hash.match(/^#conflict(?:-(\d+))?$/);
    if (!match) return false;
    if (!backups.length) await load();
    const at = match[1] ? Number(match[1]) : null;
    const index = backups.findIndex((backup) => (at ? backup.at === at : backup.reason === 'conflict'));
    if (index < 0) {
      setMessage('backup-message', '重なったときのバックアップが見つかりませんでした。古いものは自動で消えます。', 'error');
      $('backup-title').focus();
      return true;
    }
    opened.add(backups[index].at);
    if (index >= 5) showAll = true;
    render();
    const item = list.children[index];
    item.scrollIntoView({ block: 'start' });
    item.querySelector('.backup-memo button, :scope > button')?.focus({ preventScroll: true });
    return true;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.backups) return;
    // 開いている一覧の中で操作している間は、キー操作の場所を外さない
    const active = document.activeElement;
    const item = [...list.children].find((node) => node.contains(active));
    const button = item ? [...item.querySelectorAll(':scope > button')].indexOf(active) : -1;
    if (button >= 0) focusAfter = { at: Number(item.dataset.at), button };
    backups = changes.backups.newValue ?? [];
    render();
  });

  return { load, openFromHash };
}

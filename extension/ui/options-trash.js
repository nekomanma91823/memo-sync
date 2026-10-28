// 設定画面の「ゴミ箱」：戻す・完全に削除する・空にする

import { visibleIds } from '../lib/model.js';
import { readLocalDoc } from '../lib/local-doc.js';
import { formatDateTime } from '../lib/time-format.js';
import { send } from './common.js';
import { confirmInline, focusInList, foldList, makeButton, setMessage, showError } from './options-ui.js';

const $ = (id) => document.getElementById(id);

// 隠していたメモは本文を出さない（名前があれば名前だけ出す）
function describe(entry) {
  if (entry.kind === 'image') return entry.title ? `「${entry.title}」に貼ってあった画像` : '画像';
  const named = entry.title && entry.title !== '隠しているメモ';
  const title = entry.hidden ? `隠していたメモ${named ? `「${entry.title}」` : ''}` : `メモ「${entry.title || '文字なし'}」`;
  const parts = [title, `${entry.chars.toLocaleString()} 文字`];
  if (entry.images) parts.push(`画像 ${entry.images} 枚`);
  return parts.join('・');
}

export function setupTrash() {
  const list = $('trash-list');
  const more = $('trash-more');
  let showAll = false;
  let focusAt = null; // 作り直したあとにキー操作の場所を戻す位置（何番目の項目か）

  function item(entry, index) {
    const li = document.createElement('li');
    li.className = 'backup-item';
    const info = document.createElement('div');
    info.className = 'backup-info';
    const when = document.createElement('strong');
    when.textContent = formatDateTime(entry.at);
    const what = document.createElement('span');
    what.textContent = describe(entry);
    info.append(when, what);

    const restore = makeButton('戻す');
    restore.addEventListener('click', async () => {
      focusAt = index;
      try {
        const { memoId } = await send('restoreTrash', { id: entry.id });
        const doc = await readLocalDoc(chrome.storage.local);
        const number = visibleIds(doc).indexOf(memoId) + 1;
        const where = number ? `メモ ${number}` : 'メモ';
        setMessage(
          'trash-message',
          entry.kind === 'image' ? `画像を${where}に戻しました。` : `${describe(entry)}を、${where}として戻しました。`,
          'ok',
        );
      } catch (error) {
        focusAt = null;
        showError('trash-message', error, '戻せませんでした。');
      }
    });

    const remove = makeButton('完全に削除');
    remove.addEventListener('click', () => {
      confirmInline(li, {
        text: `${describe(entry)}をゴミ箱から消します。もう戻せません。`,
        yesLabel: '消す',
        returnFocus: remove,
        onYes: () => {
          focusAt = index;
          send('deleteTrash', { id: entry.id }).catch((error) => {
            focusAt = null;
            showError('trash-message', error, '消せませんでした。');
          });
        },
      });
    });

    li.append(info, restore, remove);
    return li;
  }

  async function render() {
    const { trash = [] } = await chrome.storage.local.get('trash');
    foldList(list, trash.map(item), more, { open: showAll });
    $('trash-empty').hidden = trash.length > 0;
    $('trash-actions').hidden = trash.length === 0;
    if (focusAt !== null) {
      focusInList(list, focusAt, $('trash-title'));
      focusAt = null;
    }
  }

  more.addEventListener('click', () => {
    showAll = true;
    render().then(() => focusInList(list, 5, $('trash-title')));
  });

  const clear = $('trash-clear');
  clear.addEventListener('click', () => {
    confirmInline($('trash-actions'), {
      text: 'ゴミ箱の中をすべて消します。もう戻せません。',
      yesLabel: 'すべて消す',
      returnFocus: clear,
      onYes: () => {
        focusAt = 0;
        send('deleteTrash', {}).catch((error) => {
          focusAt = null;
          showError('trash-message', error, '消せませんでした。');
        });
      },
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.trash) render();
  });

  render();
}

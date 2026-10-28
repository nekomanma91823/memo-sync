// グループの ▾（または右クリック）で開くメニュー（ポップアップとサイドパネルで共通）。
//
// Popover（最前面の層）に出すので、ポップアップの中のスクロールに切られない。開いた元のすぐ下に置き、
// 下に入りきらなければ上に出す。↑↓・Home・End で選び、Esc か外側を押すと閉じて、開いた元にフォーカスを戻す。
//
// 項目の種類：
//   { type: 'item', label, shortcut?, disabled?, danger?, onSelect }
//   { type: 'swatches', label, options: [{ key, label, hex, checked }], onSelect(key) }  色を選ぶ
//   { type: 'separator' }

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

// メニューを開くキー（Shift+F10・メニューキー・Alt+↓）
export function isMenuKey(event) {
  return (event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu' || (event.altKey && event.key === 'ArrowDown');
}

export function createMenu(box) {
  let opener = null;

  const items = () => [...box.querySelectorAll(ITEM_SELECTOR)];
  const isOpen = () => box.matches(':popover-open');

  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    if (!focus) opener = null;
    box.hidePopover();
  }

  function choose(fn) {
    close();
    fn?.();
  }

  function button(role, label, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.setAttribute('role', role);
    node.tabIndex = -1;
    node.className = 'menu-item';
    const text = document.createElement('span');
    text.className = 'menu-label';
    text.textContent = label;
    node.append(text);
    node.addEventListener('click', onClick);
    return node;
  }

  function render(entry) {
    switch (entry.type) {
      case 'separator': {
        const line = document.createElement('div');
        line.className = 'menu-separator';
        line.setAttribute('role', 'separator');
        return line;
      }
      case 'swatches':
        return swatches(entry);
      default: {
        const node = button('menuitem', entry.label, () => choose(entry.onSelect));
        node.disabled = !!entry.disabled;
        if (entry.danger) node.classList.add('menu-danger');
        if (entry.title) node.title = entry.title;
        if (entry.shortcut) {
          const key = document.createElement('kbd');
          key.textContent = entry.shortcut;
          node.append(key);
        }
        return node;
      }
    }
  }

  function swatches(entry) {
    const row = document.createElement('div');
    row.className = 'menu-swatches';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', entry.label);
    for (const option of entry.options) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'menu-swatch';
      node.setAttribute('role', 'menuitemradio');
      node.setAttribute('aria-checked', String(!!option.checked));
      node.setAttribute('aria-label', option.label);
      node.title = option.label;
      node.tabIndex = -1;
      node.style.setProperty('--dot', option.hex);
      node.addEventListener('click', () => choose(() => entry.onSelect(option.key)));
      row.append(node);
    }
    return row;
  }

  // 開いた元（anchor）の近くに置く。画面からはみ出すときは上に出すか、高さを縮めてスクロールさせる
  function place(anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    box.style.maxHeight = '';
    const below = height - rect.bottom - 8;
    const above = rect.top - 8;
    const downward = box.offsetHeight <= below || below >= above;
    const room = downward ? below : above;
    if (box.offsetHeight > room) box.style.maxHeight = `${Math.max(120, room)}px`;
    const top = downward ? rect.bottom + 4 : rect.top - 4 - box.offsetHeight;
    box.style.top = `${Math.max(4, top)}px`;
    box.style.left = `${Math.max(4, Math.min(rect.left, width - box.offsetWidth - 4))}px`;
  }

  // entries は上の項目の並び（null は飛ばす）。returnTo は閉じたときにフォーカスを戻す場所
  function open(anchor, entries, { label = '', returnTo = anchor } = {}) {
    opener = returnTo;
    box.setAttribute('aria-label', label);
    box.replaceChildren(...entries.filter(Boolean).map(render));
    if (!isOpen()) box.showPopover();
    place(anchor);
    items()[0]?.focus();
  }

  box.addEventListener('toggle', (event) => {
    if (event.newState !== 'closed') return;
    const back = opener;
    opener = null;
    // メニューの中か、どこにもフォーカスが無いときだけ戻す（外側の別のものを押したときは、そちらに任せる）
    if (back?.isConnected && (document.activeElement === document.body || box.contains(document.activeElement))) back.focus();
  });

  box.addEventListener('keydown', (event) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    const go = (index) => list[(index + list.length) % list.length]?.focus();
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(list.length - 1);
    else if (event.key === 'Tab') close();
    else return;
    event.preventDefault();
  });

  return { open, close, isOpen };
}

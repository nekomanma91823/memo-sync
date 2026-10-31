// 書式を付けて表示している間に、表を組んで見せる部分（ポップアップとサイドパネルで共通）。
// 本文は lib/markdown.js で読み、要素を 1 つずつ作る（HTML の文字列は使わない）。[画像 1] の印には、その画像を出す。
// 外のサイトの画像は読み込まない（開いただけで相手にアクセスが伝わるため）。リンクとして出す。

import { parseInline, safeHref } from '../lib/markdown.js';

function node(tag, className, children = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

// imageUrl(no) は [画像 no] の画像の URL（まだ無ければ null）、openImage(no) は画像を押したとき
export function createRenderer({ imageUrl, openImage }) {
  function inline(nodes) {
    return nodes.map((item) => {
      switch (item.type) {
        case 'text':
          return document.createTextNode(item.text);
        case 'code':
          return node('code', '', [item.text]);
        case 'strong':
          return node('strong', '', inline(item.children));
        case 'em':
          return node('em', '', inline(item.children));
        case 'del':
          return node('s', '', inline(item.children));
        case 'link':
          return link(item.href, inline(item.children));
        case 'image':
          return link(item.src, [`画像：${item.alt || item.src}`]);
        case 'mark':
          return image(item);
        default:
          return document.createTextNode('');
      }
    });
  }

  function link(href, children) {
    const safe = safeHref(href);
    if (!safe) return node('span', '', children);
    const a = node('a', '', children);
    a.href = safe;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = safe;
    return a;
  }

  // 貼った画像。押すと大きく表示する
  function image({ no, text }) {
    const url = imageUrl(no);
    if (!url) return document.createTextNode(text);
    const img = node('img');
    img.src = url;
    img.alt = `画像 ${no}`;
    const button = node('button', 'preview-image', [img]);
    button.type = 'button';
    button.tabIndex = -1;
    button.title = `画像 ${no} を大きく表示`;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => openImage(no));
    return button;
  }

  const lineOf = (text) => inline(parseInline(text.trim()));

  function table(block) {
    const cell = (tag, text, n) => {
      const element = node(tag, '', lineOf(text));
      if (block.align[n]) element.style.textAlign = block.align[n];
      return element;
    };
    const head = node('thead', '', [node('tr', '', block.head.map((text, n) => cell('th', text, n)))]);
    const body = node('tbody', '', block.rows.map((row) => node('tr', '', row.map((text, n) => cell('td', text, n)))));
    // 幅の広い表は、表だけを横に送る
    return node('div', 'preview-table', [node('table', '', [head, body])]);
  }

  return { table, image };
}

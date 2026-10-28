// メモを書式を付けて表示する部分（ポップアップとサイドパネルで共通）。
// 本文は lib/markdown.js で読み、要素を 1 つずつ作る（HTML の文字列は使わない）。
// チェックボックスを押すと、本文の [ ] と [x] を入れ替える。[画像 1] の印には、その画像を出す。
// 外のサイトの画像は読み込まない（開いただけで相手にアクセスが伝わるため）。リンクとして出す。

import { parseInline, parseMarkdown, safeHref } from '../lib/markdown.js';

const $ = (id) => document.getElementById(id);

function node(tag, className, children = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

// getText() は表示中のメモの本文、onToggleTask(line) はチェックボックスを押したとき（line は本文の何行目か）、
// imageUrl(no) は [画像 no] の画像の URL（まだ無ければ null）、openImage(no) は画像を押したとき
export function createPreview({ getText, onToggleTask, imageUrl, openImage }) {
  const box = $('preview');

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
    button.title = `画像 ${no} を大きく表示`;
    button.addEventListener('click', () => openImage(no));
    return button;
  }

  const lineOf = (text) => inline(parseInline(text.trim()));

  function withBreaks(lines) {
    return lines.flatMap((text, i) => (i ? [node('br'), ...lineOf(text)] : lineOf(text)));
  }

  function list(block) {
    const element = node(block.ordered ? 'ol' : 'ul');
    if (block.ordered && block.start !== 1) element.start = block.start;
    for (const item of block.items) {
      const li = node('li');
      if (item.task !== null) {
        li.className = 'task';
        const box = node('input');
        box.type = 'checkbox';
        box.checked = item.task;
        box.dataset.line = String(item.line);
        const label = node('span', '', withBreaks(item.lines));
        label.id = `preview-task-${item.line}`;
        box.setAttribute('aria-labelledby', label.id);
        box.addEventListener('change', () => onToggleTask(item.line));
        li.append(box, label);
      } else {
        li.append(...withBreaks(item.lines));
      }
      li.append(...item.lists.map(list));
      element.append(li);
    }
    return element;
  }

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

  function blocks(items) {
    return items.map((block) => {
      switch (block.type) {
        case 'heading':
          return node(`h${block.level}`, '', lineOf(block.text));
        case 'paragraph':
          return node('p', '', withBreaks(block.lines));
        case 'code':
          return node('pre', '', [node('code', '', [block.text])]);
        case 'hr':
          return node('hr');
        case 'quote':
          return node('blockquote', '', blocks(block.blocks));
        case 'list':
          return list(block);
        case 'table':
          return table(block);
        default:
          return node('div');
      }
    });
  }

  // 作り直しても、スクロールの位置と、押していたチェックボックスのフォーカスを保つ
  function render() {
    const text = getText();
    const { scrollTop } = box;
    const inside = box.contains(document.activeElement) && document.activeElement !== box;
    const focusedLine = inside ? document.activeElement.dataset?.line : undefined;
    box.replaceChildren(...(text.trim() ? blocks(parseMarkdown(text)) : [node('p', 'preview-empty', ['まだ何も書いていません。'])]));
    box.scrollTop = scrollTop;
    // 中のリンクや画像にフォーカスがあったときは、作り直した後は表示の枠に戻す（どこにも無い状態にしない）
    const again = focusedLine === undefined ? null : box.querySelector(`input[data-line="${focusedLine}"]`);
    if (again) again.focus();
    else if (inside) box.focus();
  }

  return { render };
}

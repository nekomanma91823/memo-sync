// メモの Markdown を、書式付きのコピー用の HTML と、記号を外した文字に変える。
//
// 書けるのは GitHub のコメントと同じくらいの書き方：見出し、箇条書き、番号付きリスト、チェックボックス、
// 引用、コード、表、区切り線、太字、斜体、取り消し線、リンク。メモなので、改行はそのまま改行にする。
// 日本語で崩れにくいように、本家の決まりより緩くしているところがある：
//   - 「**「太字」**です」のように、記号のすぐ内側や外側にかっこや句読点があっても太字にする
//   - 「#　見出し」「-　項目」のように、記号の後ろが全角の空白でもよい
//   - 「---」はいつも区切り線にする（すぐ上の行を見出しにはしない）。4 文字の字下げもコードにはしない
// 書かれた HTML はそのまま使わず、文字として出す。リンクにするのは http・https・mailto だけ。

import { trimTrailing } from './links.js';

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t　]+(.*?))?[ \t　]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t　]?(.*)$/;
const ITEM_RE = /^([ \t　]*)([-*+]|\d{1,9}[.)])(?:[ \t　]+(.*))?$/;
const TASK_RE = /^\[([ xX])\][ \t　]*(.*)$/;
const DELIM_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const URL_RE = /^https?:\/\/[^\s<>"'`「」『』（）【】、。]+/;
const MARK_RE = /^\[画像 ?(\d+)\]/;
const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SPACE_RE = /[\s　]/;
const WORD_RE = /[A-Za-z0-9]/;

// ---- 塊（見出し・段落・リストなど）に分ける ----

// 塊ごとに、前の塊との間にあった空行の数を gap に持つ（記号を外した文字で、空行をそのまま残すため）。
// リストの項目は、本文の何行目か（0 から）を line に持つ（表示の中のチェックボックスで本文を書き換えるため）
export function parseMarkdown(text) {
  return parseBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), 0);
}

// base は lines[0] が本文の何行目か（引用の中を読むとき）
function parseBlocks(lines, base) {
  const blocks = [];
  let gap = 0;
  let i = 0;
  const push = (block) => {
    blocks.push({ ...block, gap: blocks.length ? gap : 0 });
    gap = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      gap++;
      i++;
      continue;
    }
    const fence = openingFence(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i], fence.marker)) body.push(lines[i++]);
      i++; // 閉じの行。閉じていなければ最後まで
      push({ type: 'code', lang: fence.lang, text: body.join('\n') });
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      const content = (heading[2] ?? '').replace(/(^|[ \t　]+)#+$/, '');
      push({ type: 'heading', level: heading[1].length, text: content });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      push({ type: 'hr' });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const start = i;
      const inner = [];
      for (let m; i < lines.length && (m = lines[i].match(QUOTE_RE)); i++) inner.push(m[1]);
      push({ type: 'quote', blocks: parseBlocks(inner, base + start) });
      continue;
    }
    if (ITEM_RE.test(line)) {
      const { list, next } = parseList(lines, i, base);
      push(list);
      i = next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const { table, next } = parseTable(lines, i);
      push(table);
      i = next;
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) paragraph.push(lines[i++]);
    push({ type: 'paragraph', lines: paragraph });
  }
  return blocks;
}

function openingFence(line) {
  const m = line.match(FENCE_RE);
  // ``` の後ろに ` があるものは、行の中のコードとして扱う
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { marker: m[1], lang: m[2].trim() };
}

function isClosingFence(line, marker) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
}

function startsBlock(lines, i) {
  const line = lines[i];
  return !!openingFence(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || ITEM_RE.test(line) || isTableStart(lines, i);
}

// 字下げの幅。タブは 4、全角の空白は 2 と数える
function indentWidth(space) {
  let width = 0;
  for (const c of space) width += c === '\t' ? 4 : c === '　' ? 2 : 1;
  return width;
}

// ---- リスト ----

// 続く項目を集めてから、字下げで入れ子にする。項目のすぐ下の、字下げした行は項目の続き。
// 項目の間の空行はリストを切らない（gap に数えておく）。いちばん外側で箇条書きと番号が入れ替わったら、別のリストにする
function parseList(lines, start, base) {
  const items = [];
  const first = lines[start].match(ITEM_RE);
  const rootIndent = indentWidth(first[1]);
  const rootOrdered = isOrdered(first[2]);
  // 同じリストの項目として続けてよい行か
  const continues = (line) => {
    const m = line.match(ITEM_RE);
    if (!m || HR_RE.test(line)) return null;
    const indent = indentWidth(m[1]);
    if (indent < rootIndent + 2 && isOrdered(m[2]) !== rootOrdered) return null;
    return { indent, marker: m[2], text: m[3] ?? '' };
  };
  let i = start;
  let gap = 0;
  while (i < lines.length) {
    const line = lines[i];
    const item = continues(line);
    if (item) {
      items.push({ indent: item.indent, marker: item.marker, lines: [item.text], gap, line: base + i });
      gap = 0;
      i++;
      continue;
    }
    if (!line.trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && continues(lines[j])) {
        gap += j - i;
        i = j;
        continue;
      }
      break;
    }
    if (!ITEM_RE.test(line) && indentWidth(line.match(/^[ \t\u3000]*/)[0]) >= 2) {
      items.at(-1).lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  return { list: buildList(items), next: i };
}

const isOrdered = (marker) => /\d/.test(marker);

function newList(item) {
  const ordered = isOrdered(item.marker);
  return { type: 'list', ordered, start: ordered ? Number.parseInt(item.marker, 10) : 1, delimiter: ordered ? item.marker.at(-1) : '', items: [] };
}

function buildList(items) {
  const root = newList(items[0]);
  // parent は入れ子のリストを持つ項目（いちばん外側は null）
  const stack = [{ indent: items[0].indent, list: root, parent: null }];
  for (const item of items) {
    while (stack.length > 1 && item.indent < stack.at(-1).indent) stack.pop();
    let current = stack.at(-1);
    if (item.indent >= current.indent + 2 && current.list.items.length) {
      current = { indent: item.indent, list: newList(item), parent: current.list.items.at(-1) };
      current.parent.lists.push(current.list);
      stack.push(current);
    } else if (current.parent && isOrdered(item.marker) !== current.list.ordered) {
      // 入れ子の中で箇条書きと番号が入れ替わったら、同じ項目の下に別のリストを作る
      current.list = newList(item);
      current.parent.lists.push(current.list);
    }
    const [first, ...rest] = item.lines;
    const task = first.match(TASK_RE);
    current.list.items.push({
      task: task ? task[1] !== ' ' : null,
      lines: [task ? task[2] : first, ...rest],
      lists: [],
      gap: item.gap,
      line: item.line,
    });
  }
  return root;
}

// ---- 表 ----

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '\\|';
      i++;
    } else if (row[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines, i) {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes('|') || !delim.includes('|') || !DELIM_RE.test(delim)) return false;
  return splitRow(head).length === splitRow(delim).length;
}

function parseTable(lines, start) {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const cells = splitRow(lines[i++]);
    rows.push(head.map((_, n) => cells[n] ?? ''));
  }
  return { table: { type: 'table', head, align, rows }, next: i };
}

// 本文の line 行目のチェックボックスを入れる・外す。その行がチェックボックスの項目でなければ null
const TASK_LINE_RE = /^((?: {0,3}>[ \t\u3000]?)*[ \t\u3000]*(?:[-*+]|\d{1,9}[.)])[ \t\u3000]+)\[([ xX])\]/;
export function toggleTask(text, line) {
  const lines = String(text).split('\n');
  const m = lines[line]?.match(TASK_LINE_RE);
  if (!m) return null;
  lines[line] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${lines[line].slice(m[0].length)}`;
  return lines.join('\n');
}

// ---- 行の中（太字・リンクなど） ----

export function parseInline(src) {
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  const add = (node, end) => {
    flush();
    out.push(node);
    return end;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && PUNCT.includes(src[i + 1] ?? '')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = src.slice(i).match(/^`+/)[0];
      const end = findRun(src, run, i + run.length);
      if (end === -1) {
        text += run;
        i += run.length;
        continue;
      }
      let code = src.slice(i + run.length, end);
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      i = add({ type: 'code', text: code }, end + run.length);
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const link = matchLink(src, i + 1);
      if (link) {
        i = add({ type: 'image', alt: plainInline(parseInline(link.text)), src: link.href }, link.end);
        continue;
      }
    }
    if (c === '[') {
      const link = matchLink(src, i);
      if (link) {
        i = add({ type: 'link', href: link.href, children: parseInline(link.text) }, link.end);
        continue;
      }
      const mark = src.slice(i).match(MARK_RE);
      if (mark) {
        i = add({ type: 'mark', no: Number(mark[1]), text: mark[0] }, i + mark[0].length);
        continue;
      }
    }
    if (c === '<') {
      const auto = src.slice(i).match(/^<((?:https?|mailto):[^\s<>]+)>/i);
      if (auto) {
        i = add({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] }, i + auto[0].length);
        continue;
      }
    }
    if (c === 'h' && !WORD_RE.test(src[i - 1] ?? '')) {
      const bare = src.slice(i).match(URL_RE);
      if (bare) {
        const url = trimTrailing(bare[0]);
        i = add({ type: 'link', href: url, children: [{ type: 'text', text: url }] }, i + url.length);
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const emphasis = matchEmphasis(src, i);
      if (emphasis) {
        i = add(emphasis.node, emphasis.end);
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

// from から先で、run とちょうど同じ長さの ` の並びを探す
function findRun(src, run, from) {
  for (let i = from; i < src.length; ) {
    const m = src.slice(i).match(/^`+/);
    if (!m) {
      i++;
      continue;
    }
    if (m[0].length === run.length) return i;
    i += m[0].length;
  }
  return -1;
}

// [文字](URL) か [文字](<URL>)。後ろに "題" が付いていてもよい
function matchLink(src, start) {
  let depth = 0;
  let close = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
    } else if (src[i] === '[') {
      depth++;
    } else if (src[i] === ']' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1 || src[close + 1] !== '(') return null;
  let i = close + 2;
  while (src[i] === ' ') i++;
  let href = '';
  if (src[i] === '<') {
    const end = src.indexOf('>', i);
    if (end === -1) return null;
    href = src.slice(i + 1, end);
    i = end + 1;
  } else {
    let parens = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) {
        href += src[++i];
        continue;
      }
      if (SPACE_RE.test(c)) break;
      if (c === '(') parens++;
      if (c === ')' && parens-- === 0) break;
      href += c;
    }
  }
  while (src[i] === ' ') i++;
  const title = src.slice(i).match(/^(?:"[^"]*"|'[^']*')/);
  if (title) i += title[0].length;
  while (src[i] === ' ') i++;
  if (src[i] !== ')') return null;
  return { text: src.slice(start + 1, close), href, end: i + 1 };
}

// **太字** __太字__ *斜体* _斜体_ ~~取り消し~~。記号のすぐ内側が空白なら書式にしない。
// 英数字のすぐ後ろの * と _ は書式にしない（2*3*4 や snake_case を崩さない）。_ は閉じの後ろが英数字のときも
function matchEmphasis(src, i) {
  const c = src[i];
  const double = src[i + 1] === c;
  if (c === '~' && !double) return null;
  const marker = double ? c + c : c;
  const from = i + marker.length;
  if (from >= src.length || SPACE_RE.test(src[from])) return null;
  if (c !== '~' && WORD_RE.test(src[i - 1] ?? '')) return null;
  for (let j = from + 1; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === '`') {
      const run = src.slice(j).match(/^`+/)[0];
      const end = findRun(src, run, j + run.length);
      if (end !== -1) j = end + run.length - 1;
      continue;
    }
    if (src[j] !== c) continue;
    const isDouble = src[j + 1] === c;
    // 1 文字の記号を探しているときは、2 文字の並び（中の太字）を飛ばす
    if (!double && isDouble) {
      j++;
      continue;
    }
    // 2 文字の記号は、3 文字以上の並びなら最後の 2 文字で閉じる（***両方*** の中の斜体を残す）
    if (double && (!isDouble || src[j + 2] === c)) continue;
    if (SPACE_RE.test(src[j - 1])) continue;
    const end = j + marker.length;
    if (c === '_' && WORD_RE.test(src[end] ?? '')) continue;
    const type = c === '~' ? 'del' : double ? 'strong' : 'em';
    return { node: { type, children: parseInline(src.slice(from, j)) }, end };
  }
  return null;
}

// ---- 記号を外した文字 ----

export function plainInline(nodes) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
        case 'mark':
          return node.text;
        case 'link': {
          const label = plainInline(node.children);
          const url = node.href.replace(/^mailto:/i, '');
          return label === node.href || label === url || !url ? label : `${label} ${url}`;
        }
        case 'image':
          return [node.alt, node.src].filter(Boolean).join(' ');
        default:
          return plainInline(node.children);
      }
    })
    .join('');
}

const plainLine = (line) => plainInline(parseInline(line));
const breaks = (gap) => '\n'.repeat(1 + gap);

function plainList(list, depth) {
  const pad = '　'.repeat(depth);
  return list.items
    .map((item, n) => {
      const bullet = item.task !== null ? (item.task ? '☑ ' : '☐ ') : list.ordered ? `${list.start + n}${list.delimiter} ` : '・';
      const [first, ...rest] = item.lines.map(plainLine);
      const lines = [pad + bullet + first, ...rest.map((line) => `${pad}　${line}`)];
      const children = item.lists.map((child) => plainList(child, depth + 1));
      return '\n'.repeat(n ? item.gap : 0) + [...lines, ...children].join('\n');
    })
    .join('\n');
}

function plainBlock(block) {
  switch (block.type) {
    case 'heading':
      return plainLine(block.text);
    case 'paragraph':
      return block.lines.map((line) => line.match(/^[ \t　]*/)[0] + plainLine(line.trim())).join('\n');
    case 'code':
      return block.text;
    case 'hr':
      return '――――――――';
    case 'quote':
      return plainBlocks(block.blocks);
    case 'list':
      return plainList(block, 0);
    case 'table':
      return [block.head, ...block.rows].map((row) => row.map(plainLine).join('\t')).join('\n');
    default:
      return '';
  }
}

function plainBlocks(blocks) {
  return blocks.map((block, n) => (n ? breaks(block.gap) : '') + plainBlock(block)).join('');
}

// # や ** などの記号を外した文字。行の並びと空行はそのまま残す
export function markdownToPlain(text) {
  return plainBlocks(parseMarkdown(text));
}

// ---- 書式付き（HTML） ----

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function safeHref(href, protocols = ['http:', 'https:', 'mailto:']) {
  try {
    const url = new URL(href);
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const MONO = 'font-family: ui-monospace, Menlo, Consolas, monospace';
const CELL = 'border: 1px solid #c8c8c8; padding: 4px 8px';

// image(no) は [画像 N] の印に入れる画像 { src, width, height }。無ければ印の文字のまま出す
function htmlInline(nodes, image) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return escapeHtml(node.text);
        case 'code':
          return `<code style="${MONO}">${escapeHtml(node.text)}</code>`;
        case 'strong':
          return `<strong>${htmlInline(node.children, image)}</strong>`;
        case 'em':
          return `<em>${htmlInline(node.children, image)}</em>`;
        case 'del':
          return `<s>${htmlInline(node.children, image)}</s>`;
        case 'link': {
          const href = safeHref(node.href);
          const label = htmlInline(node.children, image);
          return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
        }
        case 'image': {
          const src = safeHref(node.src, ['http:', 'https:']);
          return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.alt)}">` : escapeHtml(node.alt);
        }
        case 'mark': {
          const found = image?.(node.no);
          return found ? imageTag(found, `画像 ${node.no}`) : escapeHtml(node.text);
        }
        default:
          return '';
      }
    })
    .join('');
}

// 貼った先で大きくなりすぎないように、幅を抑える
const MAX_IMAGE_WIDTH = 640;
export function imageTag({ src, width, height }, alt) {
  const size =
    width && height ? ` width="${Math.min(width, MAX_IMAGE_WIDTH)}" height="${Math.round((height * Math.min(width, MAX_IMAGE_WIDTH)) / width)}"` : '';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${size} style="max-width: 100%">`;
}

const htmlLine = (line, image) => htmlInline(parseInline(line.trim()), image);

function htmlList(list, image) {
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  const items = list.items.map((item) => {
    const box = item.task === null ? '' : item.task ? '☑ ' : '☐ ';
    const style = item.task === null ? '' : ' style="list-style-type: none"';
    const body = item.lines.map((line) => htmlLine(line, image)).join('<br>');
    return `<li${style}>${box}${body}${item.lists.map((child) => htmlList(child, image)).join('')}</li>`;
  });
  return `<${tag}${start}>${items.join('')}</${tag}>`;
}

function htmlTable(table, image) {
  const cell = (tag, text, n) => {
    const align = table.align[n] ? `; text-align: ${table.align[n]}` : '';
    return `<${tag} style="${CELL}${align}">${htmlLine(text, image)}</${tag}>`;
  };
  const head = `<tr>${table.head.map((text, n) => cell('th', text, n)).join('')}</tr>`;
  const rows = table.rows.map((row) => `<tr>${row.map((text, n) => cell('td', text, n)).join('')}</tr>`).join('');
  return `<table style="border-collapse: collapse"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function htmlBlock(block, image) {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${htmlLine(block.text, image)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${block.lines.map((line) => htmlLine(line, image)).join('<br>')}</p>`;
    case 'code':
      return `<pre style="${MONO}"><code>${escapeHtml(block.text)}</code></pre>`;
    case 'hr':
      return '<hr>';
    case 'quote':
      return `<blockquote>${htmlBlocks(block.blocks, image)}</blockquote>`;
    case 'list':
      return htmlList(block, image);
    case 'table':
      return htmlTable(block, image);
    default:
      return '';
  }
}

function htmlBlocks(blocks, image) {
  return blocks.map((block) => htmlBlock(block, image)).join('');
}

// 書式付きのコピーに入れる HTML。options.image は [画像 N] の印に入れる画像を返す関数
export function markdownToHtml(text, { image } = {}) {
  return htmlBlocks(parseMarkdown(text), image);
}

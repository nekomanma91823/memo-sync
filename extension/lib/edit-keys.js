// キー操作で本文を書き換える処理：太字などの書式を付け外しする、行の字下げを深く・浅くする。
// 書式付きの入力欄と、記号のまま表示する入力欄の両方で使う。画面を持たないので node で試せる。
//
// どれも { changes, selection } を返す。changes は元の本文での { from, to, insert } の並び（重ならず、前から順）。
// selection は書き換えた後の本文での { anchor, head }。何もしないときは null

import { parseInline } from './markdown.js';

export const INLINE_MARKS = {
  bold: { mark: '**', type: 'strong' },
  italic: { mark: '*', type: 'em' },
  strike: { mark: '~~', type: 'del' },
  code: { mark: '`', type: 'code' },
};

const QUOTE_PREFIX_RE = /^(?: {0,3}>[ \t　]?)*/;
const INDENT = '  ';

// 行ごとの { from, to, text }。from から to までに触れる行だけ
function linesBetween(text, from, to) {
  const lines = [];
  let start = text.lastIndexOf('\n', from - 1) + 1;
  while (true) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    lines.push({ from: start, to: end, text: text.slice(start, end) });
    if (nl === -1 || nl >= to) break;
    start = nl + 1;
  }
  return lines;
}

// 行の中で、from から to までを包む、いちばん内側の type の部品
function enclosing(line, from, to, type) {
  let found = null;
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.from > from || node.to < to) continue;
      if (node.type === type) found = node;
      if (node.children) walk(node.children);
    }
  };
  walk(parseInline(line.text, line.from));
  return found;
}

// 書き換えの前の位置を、書き換えた後の位置に直す。書き換えた範囲の中の位置は、その始まりに寄せる
function mapPos(pos, changes, { after = false } = {}) {
  let delta = 0;
  for (const change of changes) {
    if (change.to < pos || (change.to === pos && (change.from < pos || after))) delta += change.insert.length - (change.to - change.from);
    else if (change.from < pos) return change.from + delta + (after ? change.insert.length : 0);
  }
  return pos + delta;
}

// 太字・斜体・取り消し線・コードを付け外しする。
// 選んだ所が、その書式の中にあれば外す。無ければ、前後の空白を除いて記号で包む。何も選んでいなければ、記号を 2 つ入れて間にカーソルを置く。
// 何行かにまたがって選んだときは、行ごとに包む（書式は行をまたげないため）
export function toggleInline(text, anchor, head, kind) {
  const { mark, type } = INLINE_MARKS[kind];
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const lines = linesBetween(text, from, to);
  const parts = lines
    .map((line) => ({ line, from: Math.max(from, line.from), to: Math.min(to, line.to) }))
    .filter((part, _, all) => all.length === 1 || part.to > part.from);

  const found = parts.map((part) => enclosing(part.line, part.from, part.to, type));
  if (found.every(Boolean)) {
    const changes = found.flatMap((node) => [
      { from: node.from, to: node.start, insert: '' },
      { from: node.stop, to: node.to, insert: '' },
    ]);
    return { changes, selection: { anchor: mapPos(from, changes), head: mapPos(to, changes) } };
  }

  if (from === to) {
    // 空の記号の間にカーソルがあれば、その記号を外す（もう一度押して取り消したとき）
    const run = (pos, step) => {
      let n = 0;
      while (text[pos + step * n + (step < 0 ? -1 : 0)] === mark[0]) n++;
      return n;
    };
    if (run(from, -1) === mark.length && run(to, 1) === mark.length) {
      const changes = [{ from: from - mark.length, to: to + mark.length, insert: '' }];
      return { changes, selection: { anchor: from - mark.length, head: from - mark.length } };
    }
    const changes = [{ from, to, insert: mark + mark }];
    return { changes, selection: { anchor: from + mark.length, head: from + mark.length } };
  }
  const changes = [];
  for (const part of parts) {
    const inner = text.slice(part.from, part.to);
    const start = part.from + (inner.length - inner.trimStart().length);
    const end = part.to - (inner.length - inner.trimEnd().length);
    if (end <= start) continue;
    changes.push({ from: start, to: start, insert: mark }, { from: end, to: end, insert: mark });
  }
  if (!changes.length) return null;
  // 包んだ後も、包んだ文字を選んだままにする
  const first = changes[0].from;
  const last = changes.at(-1).to;
  return {
    changes,
    selection: { anchor: mapPos(Math.max(from, first), changes, { after: true }), head: mapPos(Math.min(to, last), changes) },
  };
}

// 選んだ行の字下げを、空白 2 つ分だけ深く（outdent なら浅く）する。引用の > の後ろで字下げする。
// 何行か選んだときは、空の行は飛ばす。浅くするときは、タブか全角の空白なら 1 文字、半角の空白なら 2 つまで外す
export function indentLines(text, anchor, head, { outdent = false } = {}) {
  const from = Math.min(anchor, head);
  let to = Math.max(anchor, head);
  // 次の行の頭までを選んでいるときは、その行は入れない
  if (to > from && text[to - 1] === '\n') to--;
  const lines = linesBetween(text, from, to);
  const changes = [];
  for (const line of lines) {
    if (lines.length > 1 && !line.text.trim()) continue;
    const at = line.from + line.text.match(QUOTE_PREFIX_RE)[0].length;
    if (!outdent) {
      changes.push({ from: at, to: at, insert: INDENT });
      continue;
    }
    const rest = text.slice(at, line.to);
    const width = /^[\t　]/.test(rest) ? 1 : rest.match(/^ {0,2}/)[0].length;
    if (width) changes.push({ from: at, to: at + width, insert: '' });
  }
  if (!changes.length) return null;
  const map = (pos) => mapPos(pos, changes, { after: true });
  return { changes, selection: { anchor: map(anchor), head: map(head) } };
}

// changes を本文に当てる
export function applyChanges(text, changes) {
  let out = '';
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + text.slice(at);
}

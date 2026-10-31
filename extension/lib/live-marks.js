// 書式を付けて表示している間の入力欄で、どこに書式を付け、どの記号を隠すかを決める。
// 画面を持たないので node で試せる。書き方の読み取りは markdown.js をそのまま使う
// （コピーした書式と見た目をそろえ、「#　見出し」のような日本語向けの決まりも同じにするため）。
//
// 返すのは部品の並び。from と to は本文の何文字目から何文字目の手前までか。
//   line    行全体の書式。line は何行目か（0 から）、cls は h1〜h6・quote・codeblock・fence・table
//   style   いつも付ける書式。cls は strong・em・del・code・link・marker・mark・done。link は href を持つ
//   hide    カーソルが近くに無いときだけ隠す記号
//   bullet  同じく、箇条書きの記号を点にする
//   task    同じく、[ ] をチェックボックスにする。checked と、何行目かの line を持つ
//   image   同じく、[画像 1] を画像にする。no を持つ
//   hr      同じく、区切り線の行を線にする
//   table   同じく、表の行をまとめて表にする。block に読み取った表を持つ
// 隠すものは reveal に [from, to] を持つ。カーソルや選んだ範囲がここに触れていたら、記号を見せる。
// 見出しと引用は行のどこか、太字やリンクはその部品、箇条書きの点とチェックボックスは記号そのものに触れたとき

import { parseInline, parseMarkdown, safeHref } from './markdown.js';

const HEADING_PREFIX_RE = /^ {0,3}#{1,6}(?:[ \t　]+|$)/;
const QUOTE_PREFIX_RE = /^ {0,3}>[ \t　]?/;
const ITEM_PREFIX_RE = /^([ \t　]*)([-*+]|\d{1,9}[.)])([ \t　]+|$)/;
const TASK_PREFIX_RE = /^\[([ xX])\]/;
const CLOSING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function liveMarks(text) {
  const src = String(text ?? '');
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const lineEnd = (n) => (n + 1 < starts.length ? starts[n + 1] - 1 : src.length);
  const out = [];

  // cols は、引用の中の行で、記号の後ろの何文字目から中身が始まるか
  function walk(blocks, cols) {
    const col = (n) => cols.get(n) ?? 0;
    const textOf = (n) => src.slice(starts[n] + col(n), lineEnd(n));
    // 行の中身を、前後の空白を除いて読む（書式付きの表示と同じ）
    const inlineLine = (n, from = 0) => {
      const rest = textOf(n).slice(from);
      const lead = rest.length - rest.trimStart().length;
      inline(parseInline(rest.trim(), starts[n] + col(n) + from + lead));
    };

    for (const block of blocks) {
      const first = block.line;
      switch (block.type) {
        case 'heading': {
          const lineFrom = starts[first];
          const prefix = textOf(first).match(HEADING_PREFIX_RE)[0].length;
          const contentFrom = lineFrom + col(first) + prefix;
          const contentTo = contentFrom + block.text.length;
          const reveal = [lineFrom, lineEnd(first)];
          out.push({ kind: 'line', line: first, cls: `h${block.level}` });
          out.push({ kind: 'hide', from: lineFrom + col(first), to: contentFrom, reveal });
          if (contentTo < lineEnd(first)) out.push({ kind: 'hide', from: contentTo, to: lineEnd(first), reveal });
          inline(parseInline(block.text, contentFrom));
          break;
        }
        case 'paragraph':
          for (let n = first; n < block.end; n++) inlineLine(n);
          break;
        case 'code': {
          const last = block.end - 1;
          const closed = last > first && CLOSING_FENCE_RE.test(textOf(last));
          for (let n = first; n < block.end; n++) {
            out.push({ kind: 'line', line: n, cls: n === first || (closed && n === last) ? 'fence' : 'codeblock' });
          }
          break;
        }
        case 'hr': {
          const from = starts[first] + col(first);
          out.push({ kind: 'hr', from, to: lineEnd(first), line: first, reveal: [starts[first], lineEnd(first)] });
          break;
        }
        case 'quote': {
          const inner = new Map(cols);
          for (let n = first; n < block.end; n++) {
            const prefix = textOf(n).match(QUOTE_PREFIX_RE)[0].length;
            const from = starts[n] + col(n);
            out.push({ kind: 'line', line: n, cls: 'quote' });
            out.push({ kind: 'hide', from, to: from + prefix, reveal: [starts[n], lineEnd(n)] });
            inner.set(n, col(n) + prefix);
          }
          walk(block.blocks, inner);
          break;
        }
        case 'list':
          list(block, col, textOf, inlineLine);
          break;
        case 'table': {
          const from = starts[first];
          const to = lineEnd(block.end - 1);
          for (let n = first; n < block.end; n++) out.push({ kind: 'line', line: n, cls: 'table' });
          out.push({ kind: 'table', from, to, block, reveal: [from, to] });
          break;
        }
      }
    }
  }

  function list(block, col, textOf, inlineLine) {
    for (const item of block.items) {
      const n = item.line;
      const lineFrom = starts[n] + col(n);
      const m = textOf(n).match(ITEM_PREFIX_RE);
      const markerFrom = lineFrom + m[1].length;
      const markerTo = markerFrom + m[2].length;
      let contentAt = m[0].length;
      if (item.task !== null) {
        const taskFrom = lineFrom + contentAt;
        const taskTo = taskFrom + textOf(n).slice(contentAt).match(TASK_PREFIX_RE)[0].length;
        // 箇条書きの点ごと、チェックボックスにする。番号付きのリストは番号を残す
        const from = block.ordered ? taskFrom : markerFrom;
        out.push({ kind: 'task', from, to: taskTo, checked: item.task, line: n, reveal: [from, taskTo] });
        contentAt = taskTo - lineFrom;
        if (item.task) {
          const done = [taskTo, lineEnd(n)];
          if (done[1] > done[0]) out.push({ kind: 'style', from: done[0], to: done[1], cls: 'done' });
        }
      } else if (!block.ordered) {
        out.push({ kind: 'bullet', from: markerFrom, to: markerTo, reveal: [markerFrom, markerTo] });
      }
      inlineLine(n, contentAt);
      for (let k = 1; k < item.lines.length; k++) inlineLine(n + k);
      for (const child of item.lists) list(child, col, textOf, inlineLine);
    }
  }

  function inline(nodes) {
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          for (const at of node.escapes ?? []) out.push({ kind: 'hide', from: at, to: at + 1, reveal: [at, at + 2] });
          break;
        case 'code':
          out.push({ kind: 'style', from: node.from, to: node.to, cls: 'code' });
          markers(node);
          break;
        case 'strong':
        case 'em':
        case 'del':
          out.push({ kind: 'style', from: node.from, to: node.to, cls: node.type });
          markers(node);
          inline(node.children);
          break;
        case 'link':
        case 'image': {
          const href = safeHref(node.type === 'image' ? node.src : node.href);
          if (href) out.push({ kind: 'style', from: node.start, to: node.stop, cls: 'link', href, reveal: [node.from, node.to] });
          if (!node.bare) markers(node);
          if (node.children) inline(node.children);
          break;
        }
        case 'mark':
          out.push({ kind: 'style', from: node.from, to: node.to, cls: 'mark' });
          out.push({ kind: 'image', from: node.from, to: node.to, no: node.no, reveal: [node.from, node.to] });
          break;
      }
    }
  }

  // 書式の前後の記号。見せている間は薄く出す
  function markers(node) {
    const reveal = [node.from, node.to];
    for (const [from, to] of [
      [node.from, node.start],
      [node.stop, node.to],
    ]) {
      if (to <= from) continue;
      out.push({ kind: 'style', from, to, cls: 'marker' });
      out.push({ kind: 'hide', from, to, reveal });
    }
  }

  walk(parseMarkdown(src), new Map());
  return out;
}

// カーソルや選んだ範囲（{ from, to } の並び）が、reveal の範囲に触れているか
export function isRevealed(item, ranges) {
  if (!item.reveal) return false;
  const [from, to] = item.reveal;
  return ranges.some((range) => range.from <= to && range.to >= from);
}

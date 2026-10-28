// すべてのメモから文字を探す・置き換える。
// 大文字と小文字、全角と半角、ひらがなとカタカナは区別しない（「めも」で「メモ」も見つかる）。
// 見つけた位置は元の本文での位置で返すので、そのまま入力欄の選択と置換に使える。

import { visibleIds } from './model.js';

const BEFORE = 30;
const AFTER = 80;

function foldChar(ch) {
  return ch
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// folded の i 文字目は、元の本文の starts[i] 〜 ends[i] から来ている
export function foldText(text) {
  let folded = '';
  const starts = [];
  const ends = [];
  for (let i = 0; i < text.length; ) {
    let size = text.codePointAt(i) > 0xffff ? 2 : 1;
    // 半角カナの濁点・半濁点（ﾄﾞ など）は、前の文字と一緒に変換して 1 文字（ド）にする
    if (/[\uff9e\uff9f]/.test(text[i + size] ?? '')) size++;
    const piece = foldChar(text.slice(i, i + size));
    for (let k = 0; k < piece.length; k++) {
      starts.push(i);
      ends.push(i + size);
    }
    folded += piece;
    i += size;
  }
  return { folded, starts, ends };
}

// 入力のたびに全メモを変換し直さないよう、本文が変わったメモだけ変換する
const cache = new Map();

function foldedMemo(id, text) {
  const hit = cache.get(id);
  if (hit?.text === text) return hit;
  const entry = { text, ...foldText(text) };
  cache.set(id, entry);
  return entry;
}

// 本文の中で needle（foldText 済み）が見つかる場所。[始まり, 終わり] を元の本文での位置で返す
function matchRanges(id, text, needle) {
  const { folded, starts, ends } = foldedMemo(id, text);
  const ranges = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    ranges.push([starts[at], ends[at + needle.length - 1]]);
  }
  return ranges;
}

// 見つけた箇所の前後を、同じ行の中だけ切り出す
function around(text, start, end) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = text.indexOf('\n', end);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const from = Math.max(lineStart, start - BEFORE);
  const to = Math.min(lineEnd, end + AFTER);
  return {
    before: (from > lineStart ? '…' : '') + text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to) + (to < lineEnd ? '…' : ''),
  };
}

// 返り値: { results: [{ id, number, start, end, before, match, after }], more, hidden }
// number は画面のメモの番号。more は limit を超えて見つかったとき true。
// 隠しているメモは探さない（結果に本文が出てしまうため）。hidden はその数
export function searchMemos(doc, query, { limit = 100 } = {}) {
  const needle = foldText(query.trim()).folded;
  const results = [];
  const ids = visibleIds(doc);
  const hidden = ids.filter((id) => doc.memos[id].hidden).length;
  if (!needle) return { results, more: false, hidden };
  for (const [index, id] of ids.entries()) {
    if (doc.memos[id].hidden) continue;
    const { text } = doc.memos[id];
    for (const [start, end] of matchRanges(id, text, needle)) {
      if (results.length >= limit) return { results, more: true, hidden };
      results.push({ id, number: index + 1, start, end, ...around(text, start, end) });
    }
  }
  return { results, more: false, hidden };
}

// 見つかる場所をすべて replacement に置き換えた本文。隠しているメモは置き換えない。
// 返り値: [{ id, number, previous: 前の本文, text: 新しい本文, count: 置き換えた数 }]（変わるメモだけ）
export function replaceMemos(doc, query, replacement) {
  const needle = foldText(query.trim()).folded;
  const changes = [];
  if (!needle) return changes;
  for (const [index, id] of visibleIds(doc).entries()) {
    const memo = doc.memos[id];
    if (memo.hidden) continue;
    let text = '';
    let last = 0;
    let count = 0;
    for (const [start, end] of matchRanges(id, memo.text, needle)) {
      // 1 文字が 2 文字に変わる字（㌔ など）で、見つけた場所が重なったときは後ろを飛ばす
      if (start < last) continue;
      text += memo.text.slice(last, start) + replacement;
      last = end;
      count++;
    }
    text += memo.text.slice(last);
    if (count && text !== memo.text) changes.push({ id, number: index + 1, previous: memo.text, text, count });
  }
  return changes;
}

// searchMemos の結果の 1 か所だけを置き換える。本文が変わって、もうその場所に無ければ null
export function replaceOne(doc, query, replacement, { id, start, end }) {
  const memo = doc.memos[id];
  const needle = foldText(query.trim()).folded;
  if (!memo || memo.deleted || memo.hidden || !needle) return null;
  if (!matchRanges(id, memo.text, needle).some(([s, e]) => s === start && e === end)) return null;
  const number = visibleIds(doc).indexOf(id) + 1;
  return { id, number, previous: memo.text, text: memo.text.slice(0, start) + replacement + memo.text.slice(end), count: 1 };
}

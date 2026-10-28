// すべてのメモから探す・置換する部分（ポップアップとサイドパネルで共通）。
// 探している間は入力欄の場所に結果を並べ、選ぶとそのメモの該当箇所を選んだ状態で開く。
// 隠しているメモは探さないし置換もしないので、見つからないときはそのことも書く。
//
// 「置換」を押すと、置換後の文字の欄が出る。結果には置き換える前と後を並べて見せる。
// 置換の欄が出ている間は、結果を押すと開かずに選ぶ（「1 件置換」で置き換える場所を選ぶため）。
// 置き換えた本文は onReplace に渡し、保存と「元に戻す」は呼んだ側で行う。

import { replaceMemos, replaceOne, searchMemos } from '../lib/search.js';

const LIMIT = 100;
const $ = (id) => document.getElementById(id);

// getDoc() は今の文書、onOpen(result) は結果を選んだとき、onToggle(open) は開閉したとき、
// onReplace(changes, { query, replacement }) は置き換えたとき（changes は lib/search.js の replaceMemos の形）
export function createSearch({ getDoc, onOpen, onToggle, onReplace }) {
  const el = {
    button: $('open-search'),
    bar: $('search'),
    input: $('search-input'),
    count: $('search-count'),
    close: $('search-close'),
    results: $('search-results'),
    list: $('search-list'),
    empty: $('search-empty'),
    toggle: $('replace-toggle'),
    row: $('replace-row'),
    replacement: $('replace-input'),
    one: $('replace-one'),
    all: $('replace-all'),
  };
  let results = [];
  let active = 0;
  // 次に選ぶ結果の場所 { number, start }。作り直してもこの場所かその次を選ぶ。null なら先頭
  let cursor = null;

  const isOpen = () => !el.bar.hidden;
  const isReplacing = () => !el.row.hidden;

  function open({ replace = false } = {}) {
    if (!isOpen()) {
      el.bar.hidden = false;
      el.results.hidden = false;
      el.button.setAttribute('aria-expanded', 'true');
      onToggle(true);
      run();
    }
    if (replace) setReplacing(true);
    // 置換で開いたときは、探す文字が入っていれば置換後の文字の欄へ
    const target = replace && el.input.value.trim() ? el.replacement : el.input;
    target.focus();
    target.select();
  }

  function close() {
    if (!isOpen()) return;
    el.bar.hidden = true;
    el.results.hidden = true;
    el.button.setAttribute('aria-expanded', 'false');
    onToggle(false);
  }

  function setReplacing(on) {
    el.row.hidden = !on;
    el.toggle.setAttribute('aria-expanded', String(on));
    run();
  }

  function run() {
    const query = el.input.value;
    const found = searchMemos(getDoc(), query, { limit: LIMIT });
    results = found.results;
    const next = cursor ? results.findIndex((r) => r.number > cursor.number || (r.number === cursor.number && r.start >= cursor.start)) : 0;
    active = Math.max(0, next);
    const hiddenNote = found.hidden ? `隠しているメモ ${found.hidden} 件は探していません。` : '';
    if (!query.trim()) {
      el.count.textContent = '';
      showEmpty(`探したい文字を入れてください。${hiddenNote}`);
    } else if (!results.length) {
      el.count.textContent = '見つかりません';
      showEmpty(`「${query.trim()}」は見つかりませんでした。${hiddenNote}`);
    } else {
      el.count.textContent = `${results.length}${found.more ? ' 件以上' : ' 件'}`;
      showEmpty('');
    }
    // ボタンを押せなくする前に、フォーカスを欄へ逃がす（押せないボタンにフォーカスが残らないように）
    if (!results.length && [el.one, el.all].includes(document.activeElement)) el.replacement.focus();
    el.one.disabled = !results.length;
    el.all.disabled = !results.length;
    paint();
  }

  function showEmpty(text) {
    el.empty.hidden = !text;
    el.empty.textContent = text;
  }

  function paint() {
    const replacing = isReplacing();
    const replacement = el.replacement.value;
    el.list.replaceChildren(
      ...results.map((result, i) => {
        const item = document.createElement('li');
        item.id = `search-result-${i}`;
        item.className = 'result';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(i === active));
        const memo = document.createElement('span');
        memo.className = 'result-memo';
        memo.textContent = `メモ ${result.number}`;
        memo.title = memo.textContent;
        const line = document.createElement('span');
        line.className = 'result-line';
        if (replacing) {
          const removed = document.createElement('del');
          removed.textContent = result.match;
          const added = document.createElement('ins');
          added.textContent = replacement;
          line.append(result.before, removed, ...(replacement ? [added] : []), result.after);
          item.title = '押すと、この場所を選びます。「1 件置換」で置き換えます';
        } else {
          const mark = document.createElement('mark');
          mark.textContent = result.match;
          line.append(result.before, mark, result.after);
        }
        item.append(memo, line);
        // 押しても検索欄から文字入力の場所が移らないようにする
        item.addEventListener('mousedown', (event) => event.preventDefault());
        item.addEventListener('click', () => (isReplacing() ? pick(i) : choose(i)));
        return item;
      }),
    );
    if (results.length) el.input.setAttribute('aria-activedescendant', `search-result-${active}`);
    else el.input.removeAttribute('aria-activedescendant');
  }

  function pick(i) {
    active = i;
    cursor = { number: results[i].number, start: results[i].start };
    paint();
    $(`search-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  function moveActive(step) {
    if (!results.length) return;
    pick((active + step + results.length) % results.length);
  }

  function choose(i) {
    const result = results[i];
    if (!result) return;
    close();
    onOpen(result);
  }

  // 選んでいる 1 か所を置き換え、その後ろの結果を選ぶ（置換後の文字に探す文字が入っていても、同じ場所を繰り返さない）
  function replaceActive() {
    const result = results[active];
    if (!result) return;
    const query = el.input.value;
    const replacement = el.replacement.value;
    const change = replaceOne(getDoc(), query, replacement, result);
    cursor = { number: result.number, start: result.start + replacement.length };
    if (change) onReplace([change], { query, replacement });
    run();
  }

  function replaceEverything() {
    const query = el.input.value;
    const replacement = el.replacement.value;
    const changes = replaceMemos(getDoc(), query, replacement);
    cursor = null;
    if (changes.length) onReplace(changes, { query, replacement });
    run();
  }

  // ↑↓ で結果を選び、Esc で閉じる。Enter は欄ごとに違う（探す欄は開く、置換後の文字の欄は 1 件置換）
  function onKeys(event, enter) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      enter();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  el.input.addEventListener('input', () => {
    cursor = null;
    run();
  });
  el.input.addEventListener('keydown', (event) => onKeys(event, () => choose(active)));
  el.replacement.addEventListener('input', paint);
  el.replacement.addEventListener('keydown', (event) => onKeys(event, replaceActive));
  el.toggle.addEventListener('click', () => {
    setReplacing(!isReplacing());
    (isReplacing() ? el.replacement : el.input).focus();
  });
  el.one.addEventListener('click', replaceActive);
  el.all.addEventListener('click', replaceEverything);
  el.close.addEventListener('click', close);
  el.button.addEventListener('click', () => (isOpen() ? close() : open()));

  // 他の端末から内容が届いたときなど、開いている間は結果を作り直す。選んでいる場所はそのまま
  function refresh() {
    if (isOpen()) run();
  }

  return { open, close, isOpen, refresh };
}

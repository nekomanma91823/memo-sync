// 入力欄の下の「要注意」：メモの中のパスワード・API キー・個人情報らしい文字を、種類ごとに出す。
// 押すと、その種類の文字を順に選ぶ。キーで押したときはフォーカスをチップに残し、何件目の何行目かを読み上げる
// （続けて押せば次の場所へ進む）。
// パスワードやキーがあるメモでは「このメモを隠しますか」と 1 回だけ聞く
// （答えたメモはこの PC の中に覚えておき、もう聞かない）。

import { findSensitive, hasSecret, summarizeSensitive } from '../lib/sensitive.js';

const ASKED_KEY = 'veilAsked';
const MAX_ASKED = 500;
const CACHE_SIZE = 200;
const TYPING_DELAY = 300;
const $ = (id) => document.getElementById(id);

// textarea は入力欄。value・setSelectionRange・focus を使う（書式を付けて表示している間は、その入力欄につなぐもの）。
// getMemo() は { memoId, hidden }（hidden は「隠す」にしたメモか）。onHide(memoId) でメモを隠す
export function createSensitiveBar({ textarea, getMemo, scrollToOffset, onHide }) {
  const el = {
    bar: $('sensitive'),
    list: $('sensitive-list'),
    where: $('sensitive-where'),
    ask: $('suggest-veil'),
    askYes: $('suggest-veil-yes'),
    askNo: $('suggest-veil-no'),
  };
  const cache = new Map(); // 本文 → 見つけたもの（タブの印でも使う）
  let asked = new Set();
  let shown = { memoId: null, findings: [] };
  let cursor = { kind: null, index: -1 };
  let dismissedFor = null; // Esc で今だけ引っ込めたメモ（画面を開き直すと、また聞く）
  let timer;

  chrome.storage.local.get(ASKED_KEY).then((value) => {
    asked = new Set(value[ASKED_KEY] ?? []);
    refresh();
  });

  function findingsOf(text) {
    let findings = cache.get(text);
    if (!findings) {
      findings = findSensitive(text);
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
      cache.set(text, findings);
    }
    return findings;
  }

  function refresh() {
    clearTimeout(timer);
    const { memoId, hidden } = getMemo();
    const findings = findingsOf(textarea.value);
    if (memoId !== shown.memoId) {
      cursor = { kind: null, index: -1 };
      el.where.textContent = '';
    }
    shown = { memoId, findings };
    const groups = summarizeSensitive(findings);
    el.bar.hidden = groups.length === 0;
    el.list.replaceChildren(...groups.map(chip));
    el.ask.hidden = !memoId || hidden || asked.has(memoId) || dismissedFor === memoId || !hasSecret(findings);
  }

  // 入力中は、打ち終わるのを少し待ってから出し直す
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, TYPING_DELAY);
  }

  function chip(group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sensitive-chip';
    button.textContent = `${group.label} ${group.count}`;
    const more = group.moreHints ? ` ほか ${group.moreHints}` : '';
    button.title = `${group.hints.length ? `${group.hints.join('、')}${more}。` : ''}押すと場所を選びます`;
    button.dataset.kind = group.kind;
    // detail が 0 のクリックは、キー（Enter・スペース）で押したもの
    button.addEventListener('click', (event) => select(group.kind, { keyboard: event.detail === 0 }));
    return button;
  }

  // 同じ種類を押すたびに、次の場所を選ぶ
  function select(kind, { keyboard = false } = {}) {
    refresh();
    const items = shown.findings.filter((found) => found.kind === kind);
    if (!items.length) return;
    cursor = { kind, index: cursor.kind === kind ? (cursor.index + 1) % items.length : 0 };
    const found = items[cursor.index];
    const line = textarea.value.slice(0, found.start).split('\n').length;
    const label = summarizeSensitive(items)[0]?.label ?? '';
    el.where.textContent = `${label} ${cursor.index + 1} / ${items.length} 件目・${line} 行目`;
    if (keyboard) {
      textarea.setSelectionRange(found.start, found.end);
      scrollToOffset(found.start);
      el.list.querySelector(`[data-kind="${kind}"]`)?.focus();
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(found.start, found.end);
    scrollToOffset(found.start);
  }

  // 「隠しますか」を、答えずに今だけ引っ込める（Esc）。出ていたら true
  function dismiss() {
    if (el.ask.hidden) return false;
    const hadFocus = el.ask.contains(document.activeElement);
    el.ask.hidden = true;
    dismissedFor = shown.memoId;
    if (hadFocus) textarea.focus();
    return true;
  }

  function remember(memoId) {
    asked.delete(memoId);
    asked.add(memoId);
    asked = new Set([...asked].slice(-MAX_ASKED));
    chrome.storage.local.set({ [ASKED_KEY]: [...asked] }).catch(() => {});
    el.ask.hidden = true;
  }

  el.askYes.addEventListener('click', () => {
    const { memoId } = shown;
    remember(memoId);
    onHide(memoId);
  });
  el.askNo.addEventListener('click', () => {
    remember(shown.memoId);
    textarea.focus();
  });

  return { findingsOf, refresh, schedule, dismiss };
}

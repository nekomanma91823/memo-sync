// 設定画面で使い回す部品：お知らせ・その場の確認・長い一覧の折りたたみ

import { describeError } from '../lib/errors.js';

const OK_CLEARS_AFTER = 4_000;
const timers = new Map();
let confirmSeq = 0;

export function makeButton(label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  return button;
}

// お知らせを出す。tone は '' | 'ok' | 'error'。うまくいったお知らせはしばらくすると消し、失敗は次の操作まで残す。
// detail は元の英語などの詳しい説明（「詳しく」に畳む）。action は { label, onClick } で、お知らせの横にボタンを出す。
// keepFor はうまくいったお知らせを出しておく長さ（ミリ秒）
export function setMessage(id, text, tone = '', { detail = '', action = null, keepFor = OK_CLEARS_AFTER } = {}) {
  const box = document.getElementById(id);
  clearTimeout(timers.get(id));
  box.className = `message ${tone}`;
  const parts = [];
  if (text) {
    const line = document.createElement('span');
    line.textContent = text;
    parts.push(line);
  }
  if (action) {
    const button = makeButton(action.label, 'message-action');
    button.addEventListener('click', action.onClick);
    parts.push(button);
  }
  if (detail) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '詳しく';
    const code = document.createElement('code');
    code.textContent = detail;
    details.append(summary, code);
    parts.push(details);
  }
  box.replaceChildren(...parts);
  if (tone === 'ok' && text) {
    timers.set(
      id,
      setTimeout(() => box.replaceChildren(), keepFor),
    );
  }
}

// 失敗を日本語で出す（元の英語は「詳しく」に）。prefix は「書き出せませんでした。」など
export function showError(id, error, prefix = '') {
  const { message, detail } = describeError(error);
  setMessage(id, `${prefix}${message}`, 'error', { detail });
}

// 取り消せない操作などの前に、その場で確かめる。警告の文はボタンに結び付け、読み上げでも聞こえるようにする。
// やめたときは returnFocus（確認を出したボタン）に戻る。Esc でもやめる
export function confirmInline(container, { text, yesLabel, onYes, returnFocus = null, tone = 'danger', yesDisabled = false }) {
  container.querySelector('.inline-confirm')?.remove();
  const box = document.createElement('div');
  box.className = `inline-confirm ${tone}`;
  const message = document.createElement('p');
  message.id = `inline-confirm-${++confirmSeq}`;
  message.textContent = text;
  const yes = makeButton(yesLabel, tone === 'danger' ? 'danger' : 'primary');
  yes.disabled = yesDisabled;
  const no = makeButton('やめる');
  for (const button of [yes, no]) button.setAttribute('aria-describedby', message.id);
  const actions = document.createElement('div');
  actions.className = 'buttons';
  actions.append(yes, no);
  box.append(message, actions);
  const cancel = () => {
    box.remove();
    returnFocus?.focus();
  };
  no.addEventListener('click', cancel);
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  });
  yes.addEventListener('click', () => {
    box.remove();
    onYes();
  });
  container.append(box);
  no.focus();
  return box;
}

// 長い一覧は最初の limit 件だけ出し、残りは「ほか N 件を表示」で開く。
// 開いたかどうかは呼ぶ側が覚えておく（作り直しても開いたままにするため）
export function foldList(list, nodes, more, { limit = 5, open = false } = {}) {
  list.replaceChildren(...nodes);
  const folded = !open && nodes.length > limit;
  nodes.forEach((node, i) => {
    node.hidden = folded && i >= limit;
  });
  more.hidden = !folded;
  more.textContent = `ほか ${nodes.length - limit} 件を表示`;
  more.setAttribute('aria-expanded', 'false');
}

// 一覧を作り直したあと、さっき操作した位置の項目（無ければ見出し）にキー操作の場所を戻す
export function focusInList(list, index, fallback) {
  const items = [...list.children].filter((item) => !item.hidden);
  const target = items[Math.min(index, items.length - 1)];
  const button = target?.querySelector('button');
  if (button) button.focus();
  else fallback?.focus();
}

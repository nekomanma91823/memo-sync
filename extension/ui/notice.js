// お知らせ（ツールバーの下の 1 行）と、上に出す帯（同期の問題・はじめての案内など）。
//
// お知らせの行は、何も無いときも高さを残しておく（出るたびにポップアップの高さが変わらないように）。
// お知らせは折り返して全文を出す。種類で消え方を変える：
//   info  … しばらくすると勝手に消える。「×」は出さない（「元に戻す」などのボタンが付くときは長めに出す）。
//           マウスが載っている間と、中のボタンにフォーカスがある間は止め、離れたら残りの時間から数え直す
//   busy  … 処理中。次のお知らせが来るまで消えない。「×」は出さない
//   error … 「×」で閉じるまで消えない。その間に info が来たら、info が消えた後にまた出す
// 読み上げには、いつも DOM にある別の要素（#notice-live）で伝える。

const $ = (id) => document.getElementById(id);
const INFO_FOR = 4_000;
const ACTION_FOR = 12_000;
const MIN_LEFT = 1_000; // 止めたあとに残す時間の下限（離れた途端に消えないように）

export function createNotices() {
  const el = {
    bar: $('notice-bar'),
    text: $('notice'),
    action: $('notice-action'),
    close: $('notice-close'),
    live: $('notice-live'),
    banners: $('banners'),
  };
  let timer = null;
  let left = 0; // 消えるまでの残り（ミリ秒）。0 なら勝手には消えない
  let since = 0; // タイマーを動かし始めた時刻
  let current = null; // { text, tone, action }
  let heldError = null; // info に場所を譲っている間のエラー

  function paint(notice) {
    current = notice;
    // 消すときに中のボタンにフォーカスがあれば、入力欄へ移す（見えないボタンに残さない）
    if (!notice && el.bar.contains(document.activeElement)) $('memo')?.focus();
    el.bar.className = notice ? `notice-bar ${notice.tone}` : 'notice-bar empty';
    if (!notice) {
      el.text.textContent = '';
      el.action.hidden = true;
      el.close.hidden = true;
      return;
    }
    el.text.textContent = notice.text;
    el.action.hidden = !notice.action;
    el.action.textContent = notice.action?.label ?? '';
    el.close.hidden = notice.tone !== 'error';
    el.live.textContent = notice.text;
  }

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }

  // 読んでいる・押そうとしている間は消さない
  const isHeld = () => el.bar.matches(':hover') || el.bar.contains(document.activeElement);

  function resume() {
    if (timer || !left || isHeld()) return;
    since = Date.now();
    timer = setTimeout(expire, left);
  }

  function pause() {
    if (!timer) return;
    stopTimer();
    left = Math.max(MIN_LEFT, left - (Date.now() - since));
  }

  // action: { label, run }。duration を渡すと、その時間で消す（info のとき）
  function show(text, tone = 'info', { action = null, duration } = {}) {
    stopTimer();
    if (tone !== 'error' && current?.tone === 'error') heldError = current;
    if (tone === 'error') heldError = null;
    paint({ text, tone, action });
    left = tone === 'info' ? (duration ?? (action ? ACTION_FOR : INFO_FOR)) : 0;
    resume();
  }

  function expire() {
    stopTimer();
    left = 0;
    const back = heldError;
    heldError = null;
    paint(back);
  }

  // 「×」を押したとき。info の後ろに控えているエラーがあれば、それを出す
  function close() {
    stopTimer();
    if (current?.tone === 'error') heldError = null;
    expire();
  }

  // 処理中のお知らせだけを消す（結果を出さずに終わったとき）
  function clearBusy() {
    if (current?.tone === 'busy') expire();
  }

  el.action.addEventListener('click', () => {
    const run = current?.action?.run;
    close();
    run?.();
  });
  el.close.addEventListener('click', close);
  el.bar.addEventListener('mouseenter', pause);
  el.bar.addEventListener('mouseleave', resume);
  el.bar.addEventListener('focusin', pause);
  el.bar.addEventListener('focusout', (event) => {
    if (!el.bar.contains(event.relatedTarget)) resume();
  });

  // ---- 帯 ----
  // tone: 'info' | 'warn' | 'danger'。actions: [{ label, run, primary }]。closable なら「閉じる」を付ける（onClose を呼ぶ）
  const banners = new Map();

  function banner(id, { tone = 'warn', text, actions = [], closable = false, onClose } = {}) {
    let box = banners.get(id);
    if (!box) {
      box = document.createElement('div');
      box.dataset.banner = id;
      banners.set(id, box);
      el.banners.append(box);
    }
    box.className = `alert ${tone}`;
    const body = document.createElement('span');
    body.className = 'alert-text';
    body.id = `banner-${id}-text`;
    const lines = Array.isArray(text) ? text : [text];
    lines.forEach((line, i) => {
      if (i) body.append(document.createElement('br'));
      body.append(line);
    });
    const buttons = document.createElement('div');
    buttons.className = 'confirm-actions';
    for (const item of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      if (item.primary) button.className = 'primary';
      button.setAttribute('aria-describedby', body.id);
      button.addEventListener('click', () => item.run());
      buttons.append(button);
    }
    if (closable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '閉じる';
      button.addEventListener('click', () => {
        removeBanner(id);
        onClose?.();
      });
      buttons.append(button);
    }
    box.replaceChildren(body, buttons);
  }

  function removeBanner(id) {
    const box = banners.get(id);
    if (!box) return;
    const hadFocus = box.contains(document.activeElement);
    box.remove();
    banners.delete(id);
    if (hadFocus) document.getElementById('memo')?.focus();
  }

  return { show, close, clearBusy, banner, removeBanner, hasBanner: (id) => banners.has(id) };
}

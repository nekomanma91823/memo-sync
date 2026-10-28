// タブやグループのチップの上で、その場で名前を書き換える欄（スプレッドシートのシート名と同じ）。
// Enter か欄の外を押すと決め、Esc でやめる。日本語の変換中の Enter では決めない。
// onEnd() は決めた・やめたの後に呼ぶ。返した要素にフォーカスを戻す（作り直したタブなど。返さなければ target）

export function editInline(target, { value = '', placeholder = '', maxLength = 40, label = '', onCommit, onEnd }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  // 書いている文字に合わせて欄の幅を変える
  const fit = () => {
    input.size = Math.max(6, Math.min(24, [...(input.value || placeholder)].length + 2));
  };
  fit();
  target.hidden = true;
  target.after(input);
  input.focus();
  input.select();

  let done = false;
  function finish(commit, { refocus = true } = {}) {
    if (done) return;
    done = true;
    const next = input.value;
    const hadFocus = document.activeElement === input;
    input.remove();
    target.hidden = false;
    if (commit) onCommit(next);
    const back = onEnd?.() ?? target;
    if (refocus && hadFocus && back?.isConnected) back.focus();
  }

  input.addEventListener('input', fit);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  // 欄の外を押したら決める（別のところを押した人のフォーカスは奪わない）
  input.addEventListener('blur', () => finish(true, { refocus: false }));
  return { cancel: () => finish(false) };
}

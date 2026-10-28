// 見た目の設定（テーマ・テーマの色・文字の大きさ・ポップアップの大きさ）を、画面を描く前に当てる。
// chrome.storage は読み終わるのを待つ間に既定の色で一瞬描かれてしまうので、
// 前回の値を localStorage に写しておき、まずそれで当てる。どの画面でも <head> で読み込む。
// （モジュールではない普通のスクリプト。ほかのファイルからは読み込まない）

(() => {
  const KEY = 'memosync-look';
  const ACCENTS = ['green', 'blue', 'purple', 'pink', 'orange', 'gray'];
  const WIDTHS = { narrow: 480, normal: 600, wide: 720, max: 800 };
  const root = document.documentElement;

  function look(prefs) {
    return {
      theme: ['light', 'dark'].includes(prefs?.theme) ? prefs.theme : 'auto',
      accent: ACCENTS.includes(prefs?.accent) ? prefs.accent : 'green',
      textSize: ['small', 'large'].includes(prefs?.textSize) ? prefs.textSize : 'normal',
      popupWidth: WIDTHS[prefs?.popupWidth] ?? WIDTHS.normal,
      // ポップアップの入力欄の高さ（入力欄の右下をドラッグして変えたもの）
      memoHeight: Number.isFinite(prefs?.memoHeight) ? Math.min(480, Math.max(120, prefs.memoHeight)) : null,
    };
  }

  function apply(value) {
    root.dataset.theme = value.theme;
    root.dataset.accent = value.accent;
    root.dataset.textSize = value.textSize;
    root.style.setProperty('--popup-width', `${value.popupWidth}px`);
    if (value.memoHeight) root.style.setProperty('--memo-height', `${value.memoHeight}px`);
    else root.style.removeProperty('--memo-height');
  }

  function remember(prefs) {
    const value = look(prefs);
    apply(value);
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      // 写せなくても、次に開いたときに少し遅れて当たるだけ
    }
  }

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    apply(saved ? { ...look(null), ...saved } : look(null));
  } catch {
    apply(look(null));
  }

  // 本当の設定は chrome.storage にある。読めたら当て直し、変わったら追いかける
  document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get('prefs').then(({ prefs }) => remember(prefs));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.prefs) remember(changes.prefs.newValue);
    });
  });
})();

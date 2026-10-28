// メモ本文から開けるリンクを取り出す。http と https だけを扱う
// （javascript: などをリンクにすると、拡張機能の画面で危険な動作をさせられるため）

const URL_RE = /https?:\/\/[^\s<>"'`「」『』（）【】、。]+/g;

export function trimTrailing(raw) {
  let url = raw.replace(/[.,;:!?]+$/, '');
  // 「(https://example.com)」のように括弧で囲まれた URL の閉じ括弧を外す
  while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) {
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return url;
}

export function extractLinks(text, limit = 100) {
  const links = [];
  const seen = new Set();
  for (const match of text.matchAll(URL_RE)) {
    let url;
    try {
      url = new URL(trimTrailing(match[0]));
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push(url.href);
    if (links.length >= limit) break;
  }
  return links;
}

export function linkLabel(href) {
  const url = new URL(href);
  let path = url.pathname === '/' ? '' : url.pathname;
  try {
    path = decodeURI(path); // 日本語の URL を %E5… ではなく読める形で見せる
  } catch {
    // 壊れたエスケープはそのまま
  }
  const label = url.hostname.replace(/^www\./, '') + path;
  return label.length > 32 ? `${label.slice(0, 31)}…` : label;
}

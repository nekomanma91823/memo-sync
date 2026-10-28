// メモの「コピー」で作る文章の形。
//
// 「コピー」はコーディング AI などに渡す用。クリップボードには文章と何枚もの画像を一緒に入れられないので、
// 画像はファイルに保存し、その場所を文章に書く。画像を貼ると、書いている場所に [画像 1] の印が入る。
// コピーではその印を Markdown の画像 ![画像 1](場所) に置き換え、印の無い画像（印を消したもの）は
// 文章の最後にまとめて書き足す。Claude Code などは、書かれた場所から画像を読める。
//
// 「書式付きでコピー」は、Slack やメールなどに貼る用。Markdown を HTML にし、画像は HTML の中に入れる。
// 書式を受け付けない貼り先には、記号を外した文字が貼られる。

import { IMAGE_EXTENSIONS } from './model.js';
import { escapeHtml, imageTag, markdownToHtml, markdownToPlain } from './markdown.js';

// 本文に入れる、画像の場所の印（no は imageNumbers の番号）
export function imageMark(no) {
  return `[画像 ${no}]`;
}

const IMAGE_MARK_RE = /\[画像 ?(\d+)\]/g;

// 「ダウンロード」フォルダの中の保存先。同じメモは同じ場所に上書きし、コピーのたびにファイルが増えないようにする
export function copyImagePath(memoId, no, type) {
  return `memosync/memo-${memoId}/image-${no}.${IMAGE_EXTENSIONS[type] ?? 'img'}`;
}

// 空白やかっこを含む場所は <> で囲む（Markdown の画像の書き方が崩れないように）
function imagePath(file) {
  return /[\s()<>]/.test(file) ? `<${file}>` : file;
}

// files は保存した画像の [{ no: 番号, file: 場所（フルパス） }]
export function memoCopyText(text, files) {
  if (!files.length) return text;
  const fileOf = new Map(files.map(({ no, file }) => [no, file]));
  const placed = new Set();
  const marked = text.replace(IMAGE_MARK_RE, (mark, n) => {
    const no = Number(n);
    if (!fileOf.has(no)) return mark;
    placed.add(no);
    return `![画像 ${no}](${imagePath(fileOf.get(no))})`;
  });
  const rest = files.filter(({ no }) => !placed.has(no));
  if (!rest.length) return marked;
  const body = marked.replace(/\s+$/, '');
  const list = rest.map(({ no, file }) => `- ![画像 ${no}](${imagePath(file)})`).join('\n');
  return `${body}${body ? '\n\n' : ''}添付画像のファイル:\n${list}\n`;
}

// 書式付きでコピーする中身。images は [{ no: 番号, src: data: の URL, width, height }]。
// 印の無い画像は、最後に「添付画像」としてまとめる
export function memoRichCopy(text, images) {
  const byNo = new Map(images.map((image) => [image.no, image]));
  const placed = new Set();
  const image = (no) => {
    if (!byNo.has(no)) return null;
    placed.add(no);
    return byNo.get(no);
  };
  let html = markdownToHtml(text, { image });
  const rest = images.filter(({ no }) => !placed.has(no));
  if (rest.length) html += `<p>${escapeHtml('添付画像')}</p>${rest.map((item) => `<p>${imageTag(item, `画像 ${item.no}`)}</p>`).join('')}`;
  return { html: `<meta charset="utf-8">${html}`, plain: markdownToPlain(text) };
}

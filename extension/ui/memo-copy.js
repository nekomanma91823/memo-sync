// 「コピー」ボタン：表示中のメモの文章と画像をまとめてコピーする（コーディング AI に渡す想定）。
// ▾ か右クリックのメニューから、ほかの形でもコピーできる：
//   書式付きでコピー … Markdown を HTML にして、Slack・Google ドキュメント・メールなどで書式が残るようにする。
//                      画像は HTML の中に入れるので、ファイルの保存も許可もいらない
//   記号を外してコピー … # や ** を外した文字だけ。LINE やフォームなど、書式を使えない所に貼る用
//
// 文章にパスワード・API キー・個人情報らしい文字があれば、コピーの前に「伏せてコピー」するかを聞く。
// 画像の中は調べない。そのことは、設定画面の「メモのコピー」に注意として書いておく。
//
// 画像は「ダウンロード」フォルダの memosync に保存し、本文の [画像 1] の印をその場所に置き換える。
// 印の無い画像は、文章の最後に書き足す（lib/copy-format.js）。
// ファイルを保存して場所を知るには downloads の許可がいるので、画像付きで初めてコピーするときだけ求める
// （インストール時の警告を増やさないよう、任意の権限にしている）。

import { imageNumbers, memoImageIds } from '../lib/model.js';
import { imageKey } from '../lib/local-doc.js';
import { base64ToBytes } from '../lib/base64.js';
import { copyImagePath, memoCopyText, memoRichCopy } from '../lib/copy-format.js';
import { markdownToPlain } from '../lib/markdown.js';
import { findSensitive, maskSensitive, summarizeSensitive } from '../lib/sensitive.js';
import { errorText } from '../lib/errors.js';
import { isMenuKey } from './menu.js';

const DOWNLOAD_TIMEOUT = 20_000;
const PERMISSION = { permissions: ['downloads'] };
const $ = (id) => document.getElementById(id);

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      fn(value);
    };
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item?.state === 'complete') finish(resolve, item);
      else if (item?.state === 'interrupted') finish(reject, new Error(errorText(item.error, '画像を保存できませんでした。')));
    };
    const listener = (delta) => {
      if (delta.id === id && delta.state) check();
    };
    const timer = setTimeout(() => finish(reject, new Error('画像の保存に時間がかかっています')), DOWNLOAD_TIMEOUT);
    chrome.downloads.onChanged.addListener(listener);
    check();
  });
}

// 画像を保存し、保存した場所（フルパス）を返す
async function saveImage(value, path) {
  const url = URL.createObjectURL(new Blob([base64ToBytes(value.data)], { type: value.type }));
  try {
    const id = await chrome.downloads.download({ url, filename: path, conflictAction: 'overwrite', saveAs: false });
    const item = await waitForDownload(id);
    return { id, file: item.filename };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// getText() は入力欄の今の文字、getMemo() は { doc, memoId }、isVeiled() はメモを隠している間 true。
// showNotice(text, tone, { action }) はお知らせ（notice.js）。openMenu(anchor, entries, options) はメニュー（menu.js）
export function createMemoCopy({ view, getMemo, getText, isVeiled, showNotice, openMenu }) {
  const el = {
    button: $('copy-memo'),
    more: $('copy-more'),
    split: $('copy-split'),
    ask: $('confirm-copy'),
    askText: $('confirm-copy-text'),
    askYes: $('confirm-copy-yes'),
    askTextOnly: $('confirm-copy-text-only'),
    askNo: $('confirm-copy-no'),
    check: $('copy-check'),
    checkList: $('copy-check-list'),
    checkMask: $('copy-check-mask'),
    checkRaw: $('copy-check-raw'),
    checkNo: $('copy-check-no'),
  };
  let granted = false;
  let working = false;
  let pending = { textOnly: false, format: 'ai' }; // 確認を出しているコピー

  const refreshPermission = () =>
    chrome.permissions.contains(PERMISSION).then((value) => {
      granted = value;
    });
  refreshPermission();
  chrome.permissions.onAdded.addListener(refreshPermission);
  chrome.permissions.onRemoved.addListener(refreshPermission);

  async function build(doc, memoId, text, imageIds) {
    const numbers = imageNumbers(doc, memoId);
    const values = imageIds.length ? await chrome.storage.local.get(imageIds.map(imageKey)) : {};
    const files = [];
    let missing = 0;
    for (const id of imageIds) {
      const value = values[imageKey(id)];
      // 他の PC で貼られて、まだこの PC に届いていない画像
      if (!value) {
        missing++;
        continue;
      }
      const no = numbers.get(id);
      const saved = await saveImage(value, copyImagePath(memoId, no, value.type));
      files.push({ no, file: saved.file });
    }
    return { data: { 'text/plain': memoCopyText(text, files) }, saved: files.length, missing };
  }

  // 書式付きでコピーする中身。画像は保存せず、HTML の中に入れる
  async function buildRich(doc, memoId, text, imageIds) {
    const numbers = imageNumbers(doc, memoId);
    const values = imageIds.length ? await chrome.storage.local.get(imageIds.map(imageKey)) : {};
    const images = [];
    let missing = 0;
    for (const id of imageIds) {
      const value = values[imageKey(id)];
      if (!value) {
        missing++;
        continue;
      }
      const { width, height } = doc.images[id] ?? {};
      images.push({ no: numbers.get(id), src: `data:${value.type};base64,${value.data}`, width, height });
    }
    const { html, plain } = memoRichCopy(text, images);
    return { data: { 'text/html': html, 'text/plain': plain }, saved: images.length, missing };
  }

  // 押した直後でないとクリップボードに書けないので、中身ができるのを待たずに渡す。
  // types はクリップボードに入れる形。result は { data: { 形: 中身 } } を返す
  function writeClipboard(result, types) {
    const item = Object.fromEntries(types.map((type) => [type, result.then(({ data }) => new Blob([data[type]], { type }))]));
    return navigator.clipboard.write([new ClipboardItem(item)]).then(() => result);
  }

  function doneText(format, { saved, missing }, masked) {
    const note = missing ? `。まだこの PC に届いていない画像 ${missing} 枚は入れていません` : '';
    if (format === 'rich') return `${masked}書式付きでコピーしました${saved ? `。画像 ${saved} 枚も入っています` : ''}${note}`;
    if (format === 'plain') return `${masked}記号を外してコピーしました${saved ? '。画像は入っていません' : ''}`;
    return saved ? `${masked}文章と画像 ${saved} 枚の場所をコピーしました${note}` : `${masked}コピーしました${note}`;
  }

  // format は 'ai'（コピー）・'rich'（書式付きでコピー）・'plain'（記号を外してコピー）。
  // checked は「AI に渡す前に確認」に答えたあと、mask は「伏せてコピー」を選んだとき
  function copy({ format = 'ai', textOnly = false, checked = false, mask = false } = {}) {
    if (working) return;
    hide();
    const { doc, memoId } = getMemo();
    const imageIds = textOnly ? [] : memoImageIds(doc, memoId);
    if (format === 'ai' && imageIds.length && !granted) {
      showAsk();
      return;
    }
    const findings = findSensitive(getText());
    if (findings.length && !checked) {
      showCheck(findings, { textOnly, format });
      return;
    }
    const text = mask ? maskSensitive(getText(), findings) : getText();
    let job;
    if (format === 'rich') {
      job = writeClipboard(buildRich(doc, memoId, text, imageIds), ['text/html', 'text/plain']);
    } else if (format === 'plain') {
      job = writeClipboard(Promise.resolve({ data: { 'text/plain': markdownToPlain(text) }, saved: imageIds.length, missing: 0 }), ['text/plain']);
    } else {
      if (imageIds.length) showNotice(`画像 ${imageIds.length} 枚を保存しています…`, 'busy');
      job = writeClipboard(build(doc, memoId, text, imageIds), ['text/plain']);
    }
    // 終わるまでもう一度は押せないようにする（二度押しで画像を 2 回保存しないため）
    working = true;
    el.button.disabled = true;
    el.more.disabled = true;
    const masked = mask && findings.length ? '見つけた文字を伏せて、' : '';
    return job
      .then((result) => showNotice(doneText(format, result, masked)))
      .catch((error) => showNotice(errorText(error, 'コピーできませんでした。'), 'error'))
      .finally(() => {
        working = false;
        el.button.disabled = false;
        el.more.disabled = false;
      });
  }

  // ▾・右クリック・Shift+F10 で開く、ほかの形でコピーするメニュー
  function openFormats(anchor = el.button) {
    if (working) return;
    openMenu(
      anchor,
      [
        { type: 'item', label: '書式付きでコピー', onSelect: () => copy({ format: 'rich' }) },
        { type: 'item', label: '記号を外してコピー', onSelect: () => copy({ format: 'plain' }) },
      ],
      { label: 'コピーの形', returnTo: el.button },
    );
  }

  function showCheck(findings, { textOnly, format }) {
    pending = { textOnly, format };
    // 隠しているメモでは、何が書いてあるかの手がかりを出さない
    const veiled = isVeiled();
    el.checkList.replaceChildren(
      ...summarizeSensitive(findings).map((group) => {
        const item = document.createElement('li');
        const more = group.moreHints ? ` ほか ${group.moreHints}` : '';
        const hints = !veiled && group.hints.length ? `：${group.hints.join('、')}${more}` : '';
        item.textContent = `${group.label} ${group.count} 件${hints}`;
        return item;
      }),
    );
    el.check.hidden = false;
    el.checkMask.focus();
  }

  // 確認・許可のお願い・お知らせを閉じる（別のメモに移ったときも。閉じたものがあれば true）
  function hide() {
    const open = !el.check.hidden || !el.ask.hidden;
    const hadFocus = [el.check, el.ask].some((box) => box.contains(document.activeElement));
    el.check.hidden = true;
    el.ask.hidden = true;
    if (hadFocus) el.button.focus();
    return open;
  }

  // ポップアップは許可の画面が出ると閉じてしまうことがあるので、設定画面で許可してもらう。
  // サイドパネルはその場で許可を求め、許可されたらそのままコピーを続ける
  function showAsk() {
    el.askText.textContent =
      view === 'popup'
        ? '画像は「ダウンロード」フォルダの memosync に保存し、その場所を文章と一緒にコピーします。そのためのファイル保存の許可を、設定画面で 1 回だけもらいます。許可したら、メモの画面に戻ってもう一度「コピー」を押してください。'
        : '画像は「ダウンロード」フォルダの memosync に保存し、その場所を文章と一緒にコピーします。最初の 1 回だけ、ファイルを保存する許可が必要です。';
    el.askYes.textContent = view === 'popup' ? '設定画面で許可する' : '許可してコピー';
    el.ask.hidden = false;
    el.askYes.focus();
  }

  function hideAsk() {
    el.ask.hidden = true;
  }

  el.button.addEventListener('click', () => copy());
  el.more.addEventListener('click', () => openFormats(el.split));
  el.button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openFormats();
  });
  el.button.addEventListener('keydown', (event) => {
    if (!isMenuKey(event)) return;
    event.preventDefault();
    openFormats();
  });
  el.askNo.addEventListener('click', () => {
    hideAsk();
    el.button.focus();
  });
  el.checkMask.addEventListener('click', () => copy({ ...pending, checked: true, mask: true }));
  el.checkRaw.addEventListener('click', () => copy({ ...pending, checked: true }));
  el.checkNo.addEventListener('click', hide);
  el.askTextOnly.addEventListener('click', () => copy({ textOnly: true }));
  el.askYes.addEventListener('click', () => {
    hideAsk();
    if (view === 'popup') {
      chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html#copy-title') });
      return;
    }
    chrome.permissions.request(PERMISSION).then((ok) => {
      granted = ok;
      el.button.focus();
      if (!ok) {
        showNotice('許可されなかったため、画像は入れられません。「文章だけコピー」なら使えます', 'error');
        return;
      }
      // 許可の画面のあとでもクリップボードに書けることが多い。書けなければ、お知らせでもう一度押してもらう
      copy();
    });
  });

  return { copy, hide };
}

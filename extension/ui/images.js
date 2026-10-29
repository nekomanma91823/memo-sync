// メモに貼った画像を、文章の下に並べる部分（ポップアップとサイドパネルで共通）。
//
// 画像を貼れるのは Google ドライブ同期のときだけ（Chrome 同期は全体で 100KB しか入らない）。
// 本体は端末内（img:<id>）に base64 で置かれているので、画面では Blob に戻して blob: の URL で表示する。
// 画像を貼ると、書いている場所に [画像 1] の印を入れ、並びのサムネイルにも同じ番号を出す。
// 「コピー」ではこの印が画像の場所に置き換わる（lib/copy-format.js）。

import { IMAGE_EXTENSIONS, IMAGE_TYPES, imageNumbers, memoImageIds } from '../lib/model.js';
import { imageMark } from '../lib/copy-format.js';
import { IMAGE_PREFIX, imageKey } from '../lib/local-doc.js';
import { base64ToBytes } from '../lib/base64.js';
import { prepareImage } from '../lib/image-prepare.js';
import { errorText } from '../lib/errors.js';
import { send } from './common.js';
import { createAnnotator } from './annotate.js';

const $ = (id) => document.getElementById(id);

function imageFiles(dataTransfer) {
  return [...(dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
}

// クリップボードに入れられる画像は PNG だけ
async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

function fileName(image) {
  const d = new Date(image.addedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `chocomemo_image_${stamp}.${IMAGE_EXTENSIONS[image.type] ?? 'img'}`;
}

// onRemoved(trashId, message) は画像を消したとき、onReplaced(newId, trashId) は印を付けて置き換えたとき（「元に戻す」を出すため）。
// canAdd() が false の間は貼らない（メモを隠しているときなど。理由は blockedMessage で知らせる）。
// openSettings() は「設定を開く」を押したとき
// insertText(text) は、入力欄の書いている場所に文字を入れる（貼った画像の印を入れるのに使う）。
// onPaint() は並びを描き直したとき（画像を読み込み終えたときも。書式を付けた表示に画像を出し直すため）
export function createImageStrip({ view: screen, showNotice, onRemoved, onReplaced, canAdd = () => true, blockedMessage = '', openSettings, focusEditor, insertText, onPaint }) {
  const el = {
    section: $('images'),
    list: $('image-list'),
    note: $('images-note'),
    viewer: $('viewer'),
    viewerImage: $('viewer-image'),
    viewerPrev: $('viewer-prev'),
    viewerNext: $('viewer-next'),
    viewerIndex: $('viewer-index'),
    viewerCopy: $('viewer-copy'),
    viewerSave: $('viewer-save'),
    viewerRemove: $('viewer-remove'),
    viewerMessage: $('viewer-message'),
    viewerClose: $('viewer-close'),
    viewerActions: document.querySelector('.viewer-actions'),
    viewerAnnotate: $('viewer-annotate'),
    canvas: $('annotate-canvas'),
    tools: $('annotate-tools'),
    toolButtons: [...document.querySelectorAll('#annotate-tools [data-tool]')],
    colorButtons: [...document.querySelectorAll('#annotate-tools [data-color]')],
    sizeButtons: [...document.querySelectorAll('#annotate-tools [data-size]')],
    sizes: $('annotate-sizes'),
    text: $('annotate-text'),
    hint: $('annotate-hint'),
    undo: $('annotate-undo'),
    save: $('annotate-save'),
    cancel: $('annotate-cancel'),
    discard: $('annotate-discard'),
    discardYes: $('annotate-discard-yes'),
    discardNo: $('annotate-discard-no'),
  };
  const annotator = createAnnotator({
    canvas: el.canvas,
    textInput: el.text,
    onChange: (marks) => {
      el.undo.disabled = marks === 0;
      el.save.disabled = marks === 0;
    },
  });
  const blobs = new Map(); // 画像の ID → { blob, url }
  const missing = new Set(); // この PC に本体がまだ無い画像
  let view = { doc: null, memoId: null, mode: 'chrome' };
  let viewing = null;
  let returnTo = null; // 大きな表示を閉じた後に戻すフォーカスの目印（何枚目か）
  let annotating = false;

  function setBlob(id, value) {
    const old = blobs.get(id);
    if (old) URL.revokeObjectURL(old.url);
    blobs.delete(id);
    missing.delete(id);
    if (typeof value?.data === 'string' && IMAGE_TYPES.includes(value.type)) {
      const blob = new Blob([base64ToBytes(value.data)], { type: value.type });
      blobs.set(id, { blob, url: URL.createObjectURL(blob) });
    } else {
      missing.add(id);
    }
  }

  async function loadBlobs(ids) {
    const wanted = ids.filter((id) => !blobs.has(id) && !missing.has(id));
    if (!wanted.length) return;
    const values = await chrome.storage.local.get(wanted.map(imageKey));
    for (const id of wanted) if (!blobs.has(id) && !missing.has(id)) setBlob(id, values[imageKey(id)]);
    paint();
  }

  function render(doc, memoId, mode) {
    view = { doc, memoId, mode };
    for (const [id, { url }] of blobs) {
      if (!doc.images[id] || doc.images[id].deleted) {
        URL.revokeObjectURL(url);
        blobs.delete(id);
      }
    }
    paint();
    loadBlobs(memoImageIds(doc, memoId));
  }

  const ids = () => memoImageIds(view.doc, view.memoId);
  const numberOf = (id) => imageNumbers(view.doc, view.memoId).get(id);

  function paint() {
    const list = ids();
    const focusedIndex = el.list.contains(document.activeElement) ? Number(document.activeElement.closest('li')?.dataset.index) : null;
    el.section.hidden = list.length === 0;
    el.note.hidden = view.mode === 'drive';
    el.note.textContent = 'Chrome の同期機能では画像は同期されません。設定で Google ドライブ同期にすると同期されます。';
    el.list.replaceChildren(...list.map(item));
    if (viewing && !list.includes(viewing)) el.viewer.close();
    else if (viewing) paintViewer();
    // 作り直しても、キー操作の場所を同じ並びの画像に残す
    if (Number.isInteger(focusedIndex)) focusThumb(focusedIndex);
    onPaint?.();
  }

  // 表示中のメモの [画像 no] の画像。まだ読み込んでいなければ null
  const idOf = (no) => (view.doc ? ids().find((id) => numberOf(id) === no) : undefined);
  const imageUrl = (no) => blobs.get(idOf(no))?.url ?? null;
  const openImage = (no) => {
    const id = idOf(no);
    if (id) openViewer(id);
  };

  function focusThumb(index) {
    const items = [...el.list.querySelectorAll('.thumb')];
    const target = items[Math.min(index, items.length - 1)];
    if (target && !target.disabled) target.focus();
    else focusEditor?.();
  }

  function item(id, index) {
    const no = numberOf(id);
    const li = document.createElement('li');
    li.className = 'image-item';
    li.dataset.index = String(index);
    // 本文の [画像 1] と同じ番号（読み上げでは、ボタンの名前で伝える）
    const badge = document.createElement('span');
    badge.className = 'thumb-no';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = String(no);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'thumb';
    const entry = blobs.get(id);
    if (entry) {
      const img = document.createElement('img');
      img.src = entry.url;
      img.alt = '';
      open.append(img);
      open.title = '大きく表示';
      open.setAttribute('aria-label', `画像 ${no} を大きく表示`);
      open.addEventListener('click', () => openViewer(id));
    } else {
      open.disabled = true;
      if (missing.has(id)) {
        const drive = view.mode === 'drive';
        open.textContent = drive ? '受信待ち' : '未受信';
        open.title = drive
          ? 'ほかの PC で貼られた画像です。同期で届くのを待っています。'
          : 'ほかの PC で貼られた画像です。Google ドライブ同期にすると届きます。';
      }
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'thumb-remove';
    remove.textContent = '×';
    remove.title = '画像を削除';
    remove.setAttribute('aria-label', `画像 ${no} を削除`);
    remove.addEventListener('click', () => removeImage(id));
    li.append(open, badge, remove);
    return li;
  }

  // ---- 削除 ----

  // すぐにゴミ箱へ移す。確かめずに、お知らせで「元に戻す」を出す
  async function removeImage(id) {
    const index = ids().indexOf(id);
    const no = numberOf(id);
    try {
      const { trashId } = await send('removeImage', { id });
      onRemoved?.(trashId, `画像 ${no} を削除しました。設定画面の「ゴミ箱」から 30 日間戻せます`);
      // 残っている画像の隣か、無ければ入力欄へ
      requestAnimationFrame(() => focusThumb(Math.max(0, index - 1)));
    } catch (error) {
      showNotice(errorText(error), 'error');
    }
  }

  // ---- 大きく表示 ----

  function openViewer(id) {
    if (!blobs.get(id)) return;
    viewing = id;
    returnTo = ids().indexOf(id);
    paintViewer();
    el.viewer.showModal();
  }

  function paintViewer() {
    const entry = blobs.get(viewing);
    if (!entry) return;
    const list = ids();
    const at = list.indexOf(viewing);
    el.viewerImage.src = entry.url;
    el.viewerMessage.textContent = '';
    el.viewerIndex.textContent = `画像 ${numberOf(viewing)}`;
    el.viewerPrev.disabled = at <= 0;
    el.viewerNext.disabled = at >= list.length - 1;
  }

  // 前後の画像へ（本体がまだ届いていない画像は飛ばす）
  function step(direction) {
    const list = ids();
    for (let at = list.indexOf(viewing) + direction; at >= 0 && at < list.length; at += direction) {
      if (blobs.has(list[at])) {
        viewing = list[at];
        returnTo = at;
        paintViewer();
        return;
      }
    }
  }

  el.viewerPrev.addEventListener('click', () => step(-1));
  el.viewerNext.addEventListener('click', () => step(1));
  el.viewer.addEventListener('keydown', (event) => {
    if (annotating) {
      // ⌘Z／Ctrl+Z で 1 つ戻す（文字の欄で打っている間は、その欄の「元に戻す」）
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && event.target !== el.text) {
        event.preventDefault();
        annotator.undo();
      }
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  el.viewer.addEventListener('close', () => {
    viewing = null;
    el.viewerImage.removeAttribute('src');
    setAnnotating(false);
    focusThumb(Math.max(0, returnTo ?? 0));
  });
  // 印を付けている途中は、Esc で閉じる前に確かめる
  el.viewer.addEventListener('cancel', (event) => {
    if (!annotating) return;
    event.preventDefault();
    askDiscard();
  });
  // 画像の外（暗いところ）を押したら閉じる。枠の内側の余白は外に数えない。印を付けている間は閉じない
  el.viewer.addEventListener('click', (event) => {
    if (event.target !== el.viewer || annotating) return;
    const rect = el.viewer.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) el.viewer.close();
  });
  el.viewerClose.addEventListener('click', () => el.viewer.close());

  el.viewerCopy.addEventListener('click', async () => {
    const entry = blobs.get(viewing);
    if (!entry) return;
    try {
      // 変換を待たずに渡す（ボタンを押した直後でないとコピーできないため）
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(entry.blob) })]);
      el.viewerMessage.textContent = 'コピーしました';
    } catch (error) {
      el.viewerMessage.textContent = errorText(error, 'コピーできませんでした。');
    }
  });

  el.viewerSave.addEventListener('click', () => {
    const entry = blobs.get(viewing);
    if (!entry) return;
    const link = document.createElement('a');
    link.href = entry.url;
    link.download = fileName(view.doc.images[viewing]);
    document.body.append(link);
    link.click();
    link.remove();
    el.viewerMessage.textContent = '「ダウンロード」に保存しました';
  });

  el.viewerRemove.addEventListener('click', () => {
    const id = viewing;
    el.viewer.close();
    removeImage(id);
  });

  // ---- 印を付ける ----

  function setAnnotating(on) {
    annotating = on;
    el.viewerImage.hidden = on;
    el.viewerActions.hidden = on;
    el.canvas.hidden = !on;
    el.tools.hidden = !on;
    el.discard.hidden = true;
    if (!on) annotator.stop();
  }

  function pick(buttons, button) {
    for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
  }

  function showHint(tool) {
    const where = screen === 'popup' ? 'ポップアップでは描く場所が狭いので、サイドパネルで開くと広く描けます。' : '';
    el.hint.textContent =
      tool === 'text'
        ? `文字を書いてから、入れたい場所を押します。置いた文字はドラッグで動かせます。${where}`
        : `画像の上をドラッグして描きます。置いた文字はドラッグで動かせます。⌘Z／Ctrl+Z で 1 つ戻せます。${where}`;
  }

  el.viewerAnnotate.addEventListener('click', async () => {
    const entry = blobs.get(viewing);
    if (!entry) return;
    if (view.mode !== 'drive') {
      el.viewerMessage.textContent = '印を付けた画像は、Google ドライブ同期のときに保存できます';
      return;
    }
    await annotator.start(entry.blob);
    setAnnotating(true);
    showHint(el.toolButtons.find((button) => button.getAttribute('aria-pressed') === 'true')?.dataset.tool);
    el.toolButtons[0].focus();
  });

  for (const button of el.toolButtons) {
    button.addEventListener('click', () => {
      pick(el.toolButtons, button);
      annotator.setTool(button.dataset.tool);
      const text = button.dataset.tool === 'text';
      el.text.hidden = !text;
      el.sizes.hidden = !text;
      showHint(button.dataset.tool);
      if (text) el.text.focus();
    });
  }
  for (const button of el.colorButtons) {
    button.addEventListener('click', () => {
      pick(el.colorButtons, button);
      annotator.setColor(button.dataset.color);
    });
  }
  for (const button of el.sizeButtons) {
    button.addEventListener('click', () => {
      pick(el.sizeButtons, button);
      annotator.setTextSize(button.dataset.size);
    });
  }
  el.undo.addEventListener('click', () => annotator.undo());

  function askDiscard() {
    if (!annotator.marks()) {
      setAnnotating(false);
      el.viewerAnnotate.focus();
      return;
    }
    el.discard.hidden = false;
    el.discardNo.focus();
  }

  el.cancel.addEventListener('click', askDiscard);
  el.discardNo.addEventListener('click', () => {
    el.discard.hidden = true;
    el.cancel.focus();
  });
  el.discardYes.addEventListener('click', () => {
    setAnnotating(false);
    el.viewerAnnotate.focus();
  });
  el.save.addEventListener('click', async () => {
    const id = viewing;
    if (!annotator.marks()) return;
    el.save.disabled = true;
    try {
      const image = await prepareImage(await annotator.toBlob());
      const { id: newId, trashId } = await send('replaceImage', { id, image });
      el.viewer.close();
      onReplaced?.(newId, trashId);
    } catch (error) {
      el.save.disabled = false;
      showNotice(errorText(error), 'error');
    }
  });

  // ---- 貼り付け・ドロップ ----

  async function addFiles(files) {
    if (!canAdd()) {
      showNotice(blockedMessage, 'error');
      return;
    }
    if (view.mode !== 'drive') {
      showNotice('画像を貼れるのは Google ドライブ同期のときだけです', 'error', { action: { label: '設定を開く', run: openSettings } });
      return;
    }
    const { memoId } = view;
    for (const [i, file] of files.entries()) {
      try {
        showNotice(files.length > 1 ? `画像を貼り付けています… ${i + 1} / ${files.length}` : '画像を貼り付けています…', 'busy');
        const id = await send('addImage', { memoId, image: await prepareImage(file) });
        // 書いている場所に [画像 1] の印を入れる。貼っている間に別のメモへ移ったときは入れない
        const { images } = await chrome.storage.local.get('images');
        const no = images?.[id]?.no;
        if (no && view.memoId === memoId) insertText?.(`${imageMark(no)}\n`);
      } catch (error) {
        showNotice(errorText(error, files.length > 1 ? `${i + 1} 枚目を貼れませんでした。` : ''), 'error');
        return;
      }
    }
    showNotice(files.length > 1 ? `画像を ${files.length} 枚貼り付けました` : '画像を貼り付けました');
  }

  function onPaste(event) {
    const files = imageFiles(event.clipboardData);
    // 表計算のセルなど、文字と画像が一緒にコピーされたときは文字として貼る
    if (!files.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    addFiles(files);
  }

  function watchDrop(area) {
    const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
    area.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      area.classList.add('dropping');
      // 隠しているメモや Chrome 同期では落とせないことを、落とす前に見せる
      area.classList.toggle('drop-blocked', !canAdd() || view.mode !== 'drive');
    });
    area.addEventListener('dragleave', (event) => {
      if (!area.contains(event.relatedTarget)) area.classList.remove('dropping', 'drop-blocked');
    });
    area.addEventListener('drop', (event) => {
      area.classList.remove('dropping', 'drop-blocked');
      if (!hasFiles(event)) return;
      // ファイルを落としても、画面がそのファイルに切り替わらないようにする
      event.preventDefault();
      const files = imageFiles(event.dataTransfer);
      if (files.length) addFiles(files);
      else showNotice('貼れるのは画像のファイルだけです', 'error');
    });
  }

  // 画像の本体が届いた・消えたとき
  function onStorageChange(changes) {
    let touched = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(IMAGE_PREFIX)) continue;
      setBlob(key.slice(IMAGE_PREFIX.length), change.newValue);
      touched = true;
    }
    if (touched && view.doc) paint();
  }

  return { render, onPaste, watchDrop, onStorageChange, imageUrl, openImage };
}

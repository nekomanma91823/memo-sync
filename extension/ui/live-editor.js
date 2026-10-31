// 書式を付けて表示している間の入力欄（ポップアップとサイドパネルで共通）。CodeMirror で作る。
// 見出しや太字に書式を付け、カーソルが近くに無い記号を隠す。書式を付けたまま、そのまま書ける。
// 本文はいつも記号の付いたまま持つ（保存もコピーも、記号のまま表示する入力欄と同じ）。
// どこを隠すかは lib/live-marks.js が決める。
// チェックボックスは押すと [ ] と [x] を入れ替え、[画像 1] の印には画像を出し、リンクは押すと開く。
// 「元に戻す」で戻るのは、この入力欄で書いたものとチェックボックスだけ。他の端末から届いた変更は戻さない。
// ⌘B などの書式と Tab の字下げは lib/edit-keys.js（記号のまま表示する入力欄と同じ）。Esc を押してから Tab を押すと、入力欄の外へ移る。

import {
  Annotation,
  Compartment,
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  StateEffect,
  StateField,
  Transaction,
  WidgetType,
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  keymap,
  placeholder,
} from '../vendor/codemirror.js';
import { isRevealed, liveMarks } from '../lib/live-marks.js';
import { toggleTask } from '../lib/markdown.js';
import { indentLines, toggleInline } from '../lib/edit-keys.js';
import { createRenderer } from './preview.js';

// 他の端末の内容や置換を映す変更。保存し直さない
const External = Annotation.define();
const setFocused = StateEffect.define();
// 画像が読み込めたときなど、本文は同じで見た目だけを作り直す
const repaint = StateEffect.define();

const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^(?:[ \t　]*>[ \t　]?)+/;
const ITEM_RE = /^((?:[ \t　]*>[ \t　]?)*)([ \t　]*)(?:([-*+])|(\d{1,9})([.)]))([ \t　]+)(\[[ xX]\]([ \t　]+))?/;

// Enter で、箇条書き・番号・チェックボックス・引用の記号を次の行にも付ける。
// 中身の無い項目で Enter を押したら、記号を外してリストを終える
function continueMarkup(view) {
  const { state } = view;
  const range = state.selection.main;
  if (view.composing || state.selection.ranges.length > 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const at = range.head - line.from;
  if (HR_RE.test(line.text)) return false;
  const insert = (text) => {
    view.dispatch({ changes: { from: range.head, insert: text }, selection: { anchor: range.head + text.length }, scrollIntoView: true, userEvent: 'input' });
    return true;
  };
  const clear = (from) => {
    view.dispatch({ changes: { from: line.from + from, to: line.to }, selection: { anchor: line.from + from }, userEvent: 'delete' });
    return true;
  };
  const m = line.text.match(ITEM_RE);
  if (m) {
    if (at < m[0].length) return false;
    if (!line.text.slice(m[0].length).trim()) return clear(m[1].length);
    const marker = m[3] ?? `${Number(m[4]) + 1}${m[5]}`;
    return insert(`\n${m[1]}${m[2]}${marker}${m[6]}${m[7] ? `[ ]${m[8]}` : ''}`);
  }
  const quote = line.text.match(QUOTE_RE)?.[0];
  if (!quote || at < quote.length) return false;
  if (!line.text.slice(quote.length).trim()) return clear(0);
  return insert(`\n${quote}`);
}

// lib/edit-keys.js の書き換えを、選んでいる所に当てる。日本語の変換中は何もしない。
// 前後に書いた文字とまとめずに、1 回の「元に戻す」で戻るようにする
function runEdit(view, edit) {
  if (view.composing || view.state.readOnly) return false;
  const { anchor, head } = view.state.selection.main;
  const result = edit(view.state.doc.toString(), anchor, head);
  if (result) {
    view.dispatch({ changes: result.changes, selection: result.selection, scrollIntoView: true, userEvent: 'input', annotations: isolateHistory.of('full') });
  }
  return true;
}

const editKeys = [
  { key: 'Mod-b', run: (view) => runEdit(view, (text, a, h) => toggleInline(text, a, h, 'bold')) },
  { key: 'Mod-i', run: (view) => runEdit(view, (text, a, h) => toggleInline(text, a, h, 'italic')) },
  { key: 'Mod-Shift-x', run: (view) => runEdit(view, (text, a, h) => toggleInline(text, a, h, 'strike')) },
  { key: 'Mod-Shift-c', run: (view) => runEdit(view, (text, a, h) => toggleInline(text, a, h, 'code')) },
  { key: 'Tab', run: (view) => runEdit(view, (text, a, h) => indentLines(text, a, h)) },
  { key: 'Shift-Tab', run: (view) => runEdit(view, (text, a, h) => indentLines(text, a, h, { outdent: true })) },
];

// チェックボックスを押したとき。本文の n 行目の [ ] と [x] を入れ替える（書いたときと同じく、元に戻せる）
function toggleLine(view, n) {
  if (view.state.readOnly || n >= view.state.doc.lines) return;
  const line = view.state.doc.line(n + 1);
  const next = toggleTask(line.text, 0);
  if (next !== null) view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: 'input' });
}

// parent に入力欄を作る。
// onChange(text) は書いたとき、onSelect() はカーソルや選んだ範囲が変わったとき、onTooLong() は長さの上限を超えそうなとき。
// imageUrl(no) は [画像 no] の画像の URL、openImage(no) は画像を押したとき、openLink(href) はリンクを押したとき、
// onCompositionEnd() は日本語の変換を終えたとき
export function createLiveEditor({ parent, maxLength, onChange, onSelect, onTooLong, imageUrl, openImage, openLink, onCompositionEnd }) {
  const renderer = createRenderer({ imageUrl, openImage });

  class BulletWidget extends WidgetType {
    eq() {
      return true;
    }
    toDOM() {
      const span = document.createElement('span');
      span.className = 'cm-md-bullet';
      span.textContent = '•';
      span.setAttribute('aria-hidden', 'true');
      return span;
    }
  }

  class TaskWidget extends WidgetType {
    constructor(checked, line) {
      super();
      this.checked = checked;
      this.line = line;
    }
    eq(other) {
      return other.checked === this.checked && other.line === this.line;
    }
    toDOM(view) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'cm-md-task';
      box.checked = this.checked;
      box.tabIndex = -1;
      box.setAttribute('aria-label', this.checked ? '済み' : 'まだ');
      // 押してもカーソルを動かさず、本文の [ ] と [x] を入れ替える
      box.addEventListener('mousedown', (event) => event.preventDefault());
      box.addEventListener('click', (event) => {
        event.preventDefault();
        toggleLine(view, this.line);
      });
      return box;
    }
  }

  class ImageWidget extends WidgetType {
    constructor(no, url) {
      super();
      this.no = no;
      this.url = url;
    }
    eq(other) {
      return other.no === this.no && other.url === this.url;
    }
    toDOM(view) {
      const button = renderer.image({ no: this.no, text: '' });
      button.classList.add('cm-md-image');
      // 読み込めて高さが変わったら、入力欄に測り直してもらう
      button.querySelector('img')?.addEventListener('load', () => view.requestMeasure());
      return button;
    }
  }

  class TableWidget extends WidgetType {
    constructor(block, source) {
      super();
      this.block = block;
      this.source = source;
    }
    eq(other) {
      return other.source === this.source;
    }
    toDOM() {
      const box = renderer.table(this.block);
      box.classList.add('cm-md-table-view');
      return box;
    }
    // 押したら表の中にカーソルを置いて、記号のまま見せる
    ignoreEvent() {
      return false;
    }
  }

  const bullet = Decoration.replace({ widget: new BulletWidget() });
  const hidden = Decoration.replace({});
  const lineClass = new Map();
  const lineDeco = (cls) => {
    if (!lineClass.has(cls)) lineClass.set(cls, Decoration.line({ class: `cm-md-${cls}` }));
    return lineClass.get(cls);
  };
  const markClass = new Map();
  const markDeco = (cls) => {
    if (!markClass.has(cls)) markClass.set(cls, Decoration.mark({ class: `cm-md-${cls}` }));
    return markClass.get(cls);
  };

  const focusField = StateField.define({
    create: () => false,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setFocused)) value = effect.value;
      return value;
    },
  });

  // 本文が変わったときだけ読み直す
  const marksField = StateField.define({
    create: (state) => liveMarks(state.doc.toString()),
    update: (value, tr) => (tr.docChanged ? liveMarks(tr.newDoc.toString()) : value),
  });

  // 見せている記号は、カーソルの場所で変わる。入力欄の外にフォーカスがあるときは、すべて隠す
  function build(state) {
    const items = state.field(marksField);
    const ranges = state.field(focusField) ? state.selection.ranges : [];
    const doc = state.doc;
    const lineStart = (n) => doc.line(n + 1).from;
    const decos = [];
    const replaces = [];
    const tableLines = new Set();
    for (const item of items) {
      if (item.kind !== 'table' || isRevealed(item, ranges)) continue;
      const first = doc.lineAt(item.from).number;
      const last = doc.lineAt(item.to).number;
      for (let n = first; n <= last; n++) tableLines.add(n - 1);
      replaces.push(
        Decoration.replace({ widget: new TableWidget(item.block, doc.sliceString(item.from, item.to)), block: true }).range(item.from, item.to),
      );
    }
    for (const item of items) {
      switch (item.kind) {
        case 'line':
          if (!tableLines.has(item.line)) decos.push(lineDeco(item.cls).range(lineStart(item.line)));
          break;
        case 'style':
          if (item.to <= item.from) break;
          decos.push(
            (item.href ? Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': item.href, title: item.href } }) : markDeco(item.cls)).range(item.from, item.to),
          );
          break;
        case 'hide':
          if (item.to > item.from && !isRevealed(item, ranges)) replaces.push(hidden.range(item.from, item.to));
          break;
        case 'bullet':
          if (!isRevealed(item, ranges)) replaces.push(bullet.range(item.from, item.to));
          break;
        case 'task':
          if (!isRevealed(item, ranges)) replaces.push(Decoration.replace({ widget: new TaskWidget(item.checked, item.line) }).range(item.from, item.to));
          break;
        case 'image': {
          const url = imageUrl(item.no);
          if (url && !isRevealed(item, ranges)) replaces.push(Decoration.replace({ widget: new ImageWidget(item.no, url) }).range(item.from, item.to));
          break;
        }
        case 'hr':
          if (isRevealed(item, ranges)) break;
          decos.push(lineDeco('hr').range(lineStart(item.line)));
          if (item.to > item.from) replaces.push(hidden.range(item.from, item.to));
          break;
      }
    }
    // 隠す範囲どうしが重なったら、先に始まるほうだけを使う
    replaces.sort((a, b) => a.from - b.from || b.to - a.to);
    let end = -1;
    for (const range of replaces) {
      if (range.from < end) continue;
      decos.push(range);
      end = range.to;
    }
    return Decoration.set(decos, true);
  }

  const decoField = StateField.define({
    create: build,
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((effect) => effect.is(setFocused) || effect.is(repaint))) return build(tr.state);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  // 上限を超える入力は受け付けない（他の端末の内容を映すときは除く）
  const limitLength = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(External) || tr.newDoc.length <= maxLength || tr.newDoc.length <= tr.startState.doc.length) return tr;
    onTooLong();
    return [];
  });

  // リンクを押したら開く。カーソルがそのリンクにあって記号を見せている間は、⌘ か Ctrl を押しながらのときだけ開く
  function onMouseDown(event, view) {
    if (event.button !== 0) return false;
    const target = event.target.closest?.('[data-href], a[href]');
    if (!target || !view.contentDOM.contains(target)) return false;
    const href = target.dataset.href ?? target.getAttribute('href');
    if (!(event.metaKey || event.ctrlKey) && target.dataset.href) {
      const pos = view.posAtDOM(target);
      const ranges = view.state.field(focusField) ? view.state.selection.ranges : [];
      const item = view.state.field(marksField).find((mark) => mark.href && mark.from <= pos && pos <= mark.to);
      if (item && isRevealed(item, ranges)) return false;
    }
    event.preventDefault();
    openLink(href);
    return true;
  }

  const hasImageFile = (data) => [...(data?.items ?? [])].some((item) => item.kind === 'file' && item.type.startsWith('image/'));

  let editableNow = false;
  let hintNow = '';
  const editable = new Compartment();
  const hint = new Compartment();
  const editableConfig = (on) => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];

  const extensions = () => [
    keymap.of([{ key: 'Enter', run: continueMarkup }, ...editKeys]),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    editable.of(editableConfig(editableNow)),
    hint.of(placeholder(hintNow)),
    EditorView.contentAttributes.of({ 'aria-label': 'メモ', 'aria-multiline': 'true', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
    focusField,
    marksField,
    decoField,
    limitLength,
    EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.docChanged && !tr.annotation(External))) onChange(update.state.doc.toString());
      if (update.selectionSet || update.focusChanged) onSelect?.();
    }),
    EditorView.domEventHandlers({
      mousedown: onMouseDown,
      // 表の中のリンクは、押したときに開いているので、二重に開かない
      click: (event) => {
        if (!event.target.closest?.('a[href]')) return false;
        event.preventDefault();
        return true;
      },
      // 画像だけを貼ったときと、ファイルを持ってきたときは、画像を貼る仕組みに任せる
      paste: (event) => hasImageFile(event.clipboardData) && !event.clipboardData.getData('text/plain'),
      drop: (event) => [...(event.dataTransfer?.types ?? [])].includes('Files'),
      compositionend: () => {
        setTimeout(() => onCompositionEnd?.(), 0);
        return false;
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: extensions() }) });

  const clamp = (pos) => Math.min(pos, view.state.doc.length);

  return {
    dom: view.dom,
    getText: () => view.state.doc.toString(),
    // 別のメモに替えるとき。「元に戻す」の記録も新しくする
    setText(text) {
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      if (view.hasFocus) view.dispatch({ effects: setFocused.of(true) });
    },
    // 他の端末で変わった内容を映す。変わったところだけを差し替え、カーソルを保つ
    applyText(next) {
      const old = view.state.doc.toString();
      if (old === next) return;
      let start = 0;
      while (start < old.length && start < next.length && old[start] === next[start]) start++;
      let tail = 0;
      while (tail < old.length - start && tail < next.length - start && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
      view.dispatch({
        changes: { from: start, to: old.length - tail, insert: next.slice(start, next.length - tail) },
        annotations: [External.of(true), Transaction.addToHistory.of(false)],
      });
    },
    // カーソルの場所に文字を入れる（選んでいる文字は消さず、その前に入れる）
    insert(text) {
      const { from } = view.state.selection.main;
      view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: 'input' });
      view.focus();
    },
    // start から end までを選ぶ。scroll が true なら、入力欄の上のほうに見えるようにする
    select(start, end = start, { focus = true, scroll = true } = {}) {
      const effects = scroll ? EditorView.scrollIntoView(clamp(start), { y: 'start', yMargin: view.scrollDOM.clientHeight / 3 }) : [];
      view.dispatch({ selection: EditorSelection.single(clamp(start), clamp(end)), effects });
      if (focus) view.focus();
    },
    selection() {
      const { from, to } = view.state.selection.main;
      return { start: from, end: to };
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    composing: () => view.composing,
    repaint: () => view.dispatch({ effects: repaint.of(null) }),
    setEditable(on) {
      editableNow = on;
      view.dispatch({ effects: editable.reconfigure(editableConfig(on)) });
    },
    setPlaceholder(text) {
      hintNow = text;
      view.dispatch({ effects: hint.reconfigure(placeholder(text)) });
    },
  };
}

// extension/vendor/codemirror.js にまとめる部品。使うものだけを書き出す。
// 書き換えたら npm run vendor で作り直す

export { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
export { Decoration, EditorView, WidgetType, keymap, placeholder } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';

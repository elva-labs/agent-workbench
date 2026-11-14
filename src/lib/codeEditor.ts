import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";

/**
 * The editor as CodeMirror builds it: line numbers, the line the cursor is
 * on, undo and redo, and find in the file, with nothing that completes or
 * highlights. No language package is loaded.
 *
 * The keys are CodeMirror's own for moving and editing, less the two the app
 * holds while the editor has the keyboard: find, which the app opens here
 * through its own chord so that rebinding it moves both, and Cmd+D, which is
 * the viewer's chord. Undo also answers the Edit menu, which reaches the page
 * as an input event rather than a key.
 *
 * Every colour is one of the app's tokens and the face is the terminal's, so
 * the editor follows the look, the palette, the appearance and the font the
 * user chose without being told; the size comes from the page.
 */

/** Keys the app answers itself while the editor has the keyboard. */
const HELD = new Set(["Mod-f", "Mod-d"]);

let listener: ((update: ViewUpdate) => void) | null = null;

/** Who hears every change the editor makes: the store, which keeps each
    file's state and marks what is unsaved. */
export function onEditorUpdate(handler: ((update: ViewUpdate) => void) | null) {
  listener = handler;
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--ink)",
    backgroundColor: "var(--surface)",
    fontSize: "var(--editor-size, 12px)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "8px 0 40px",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0 24px 0 4px" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--ink-3)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "40px",
    padding: "0 12px 0 8px",
    opacity: "0.75",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--ink) 5%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--ink) 5%, transparent)",
    color: "var(--ink)",
  },
  ".cm-activeLineGutter.cm-gutterElement": { opacity: "1" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "1.5px solid var(--accent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
    },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 38%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--ink-2)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--head-rule)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--head-rule)" },
  ".cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 8px",
    padding: "6px 10px",
    fontFamily: "var(--chrome)",
    fontSize: "12px",
  },
  ".cm-search br": { display: "none" },
  ".cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "12px",
    color: "var(--ink-3)",
  },
  ".cm-textfield": {
    height: "24px",
    padding: "0 8px",
    border: "1px solid var(--field-border)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--field-bg)",
    color: "var(--ink)",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    outline: "none",
  },
  ".cm-textfield:focus": {
    boxShadow: "0 0 0 1.5px var(--accent)",
  },
  ".cm-button": {
    height: "24px",
    padding: "0 9px",
    border: "0",
    borderRadius: "var(--radius-sm)",
    backgroundImage: "none",
    backgroundColor: "transparent",
    boxShadow: "inset 0 0 0 1px var(--rule-strong)",
    color: "var(--ink-2)",
    fontFamily: "var(--chrome)",
    fontSize: "var(--btn-size)",
    textTransform: "var(--label-case)",
    letterSpacing: "var(--label-track-tight)",
    cursor: "pointer",
  },
  ".cm-button:hover": { color: "var(--ink)" },
  ".cm-search button[name=close]": {
    marginLeft: "auto",
    border: "0",
    background: "none",
    color: "var(--ink-3)",
    fontSize: "16px",
    cursor: "pointer",
  },
});

/** Everything a file's state carries. Shared by every file, so switching
    tabs swaps one state for another and nothing is set up again. */
export const extensions: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  EditorState.allowMultipleSelections.of(true),
  highlightActiveLine(),
  search({ top: true }),
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap.filter((binding) => !HELD.has(binding.key ?? "")),
    indentWithTab,
  ]),
  theme,
  EditorView.updateListener.of((update) => listener?.(update)),
];

/** A file's text as a fresh state: the cursor at the top, no history. */
export function stateFor(text: string): EditorState {
  return EditorState.create({ doc: text, extensions });
}

/** The part of `next` that differs from `prev`, as one change from the
    first character that differs to the last: what a reload replaces, so
    the cursor, the selection and the scroll before and after it hold. */
export function changeBetween(
  prev: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (prev === next) return null;
  let start = 0;
  const shortest = Math.min(prev.length, next.length);
  while (start < shortest && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}

const LANGUAGES: Record<string, string> = {
  md: "Markdown",
  markdown: "Markdown",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  svelte: "Svelte",
  vue: "Vue",
  rs: "Rust",
  go: "Go",
  py: "Python",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  json: "JSON",
  jsonc: "JSON",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  tf: "Terraform",
  lua: "Lua",
  php: "PHP",
};

/** What a file is written in, by its name, for the editor's foot. */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Dockerfile") return "Dockerfile";
  if (name === "Makefile") return "Makefile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "Plain text";
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? "Plain text";
}

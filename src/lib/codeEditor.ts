import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  searchKeymap,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";

/**
 * The editor as CodeMirror builds it: line numbers, the line the cursor is
 * on, undo and redo, and find in the file, with nothing that completes or
 * highlights. No language package is loaded.
 *
 * The keys are CodeMirror's own for moving and editing, Cmd+D for the next
 * occurrence among them, less find, which the app opens here through its
 * own chord so that rebinding it moves both. Undo also answers the Edit
 * menu, which reaches the page as an input event rather than a key.
 *
 * Every colour is one of the app's tokens and the face is the terminal's, so
 * the editor follows the look, the palette, the appearance and the font the
 * user chose without being told; the size comes from the page.
 */

/** Keys the app answers itself while the editor has the keyboard. */
const HELD = new Set(["Mod-f"]);

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
    outline: "none",
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
  ".cm-find": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 8px",
    padding: "6px 10px",
    fontFamily: "var(--chrome)",
    fontSize: "var(--btn-size)",
  },
  ".cm-find-field": {
    flex: "1 1 180px",
    minWidth: "120px",
    height: "26px",
    padding: "0 9px",
    border: "1px solid var(--field-border)",
    borderRadius: "var(--radius)",
    backgroundColor: "var(--field-bg)",
    color: "var(--ink)",
    fontFamily: "var(--chrome)",
    fontSize: "var(--field-size)",
    outline: "none",
  },
  ".cm-find-field:focus": { boxShadow: "0 0 0 1.5px var(--accent)" },
  ".cm-find-field::placeholder": { color: "var(--ink-3)" },
  ".cm-find-count": {
    minWidth: "72px",
    color: "var(--ink-3)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  ".cm-find-group": {
    display: "flex",
    gap: "0",
    padding: "2px",
    borderRadius: "var(--radius)",
    backgroundColor: "color-mix(in srgb, var(--surface-2) 70%, var(--ink) 6%)",
  },
  ".cm-find-button": {
    height: "22px",
    padding: "0 9px",
    border: "0",
    borderRadius: "var(--radius-sm)",
    background: "none",
    color: "var(--ink-3)",
    fontFamily: "var(--chrome)",
    fontSize: "var(--btn-size)",
    letterSpacing: "var(--label-track-tight)",
    textTransform: "var(--label-case)",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-find-button:hover": { color: "var(--ink)" },
  ".cm-find-button[aria-pressed=true]": {
    backgroundColor: "var(--surface)",
    color: "var(--ink)",
    boxShadow: "0 0 0 1px var(--head-rule)",
  },
  ".cm-find-close": {
    width: "24px",
    height: "24px",
    marginLeft: "auto",
    border: "0",
    borderRadius: "var(--radius-sm)",
    background: "none",
    color: "var(--ink-3)",
    fontSize: "15px",
    lineHeight: "1",
    cursor: "pointer",
  },
  ".cm-find-close:hover": { backgroundColor: "var(--surface-2)", color: "var(--ink)" },
  ".cm-find button:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
});

/** Past this many, the find bar counts no further. */
const MOST_COUNTED = 999;
/** A file longer than this is counted only once typing pauses, the query's
    as well as the file's: a count walks the whole file. */
export const LARGE_FILE = 200_000;
/** How long typing pauses before a count, in milliseconds. */
export const COUNT_AFTER = 300;

/**
 * Find in the file, in the app's own look and words: the field, how many
 * matches there are, Previous, Next and All, and whether case, whole words
 * or a regular expression count. Enter is the next match, Shift+Enter the
 * one before, Escape closes it. There is nothing to replace with.
 *
 * Counting walks the whole file, so it is done when the query changes, at
 * once for a small file and after a pause for a large one, and after typing
 * in the file pauses, never on every key.
 */
class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private field: HTMLInputElement;
  private count: HTMLElement;
  private toggles: Record<"caseSensitive" | "wholeWord" | "regexp", HTMLButtonElement>;
  private query: SearchQuery;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, text = "") => {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
      if (text !== "") node.textContent = text;
      return node;
    };
    this.field = make("input", {
      class: "cm-find-field",
      name: "search",
      placeholder: "Find in file",
      "aria-label": "Find in file",
      "main-field": "true",
      spellcheck: "false",
      autocomplete: "off",
      "data-testid": "find-field",
    });
    this.field.value = this.query.search;
    this.field.addEventListener("input", () => this.commit());
    this.count = make("span", { class: "cm-find-count", "aria-live": "polite", "data-testid": "find-count" });
    const button = (label: string, run: () => void, testid: string) => {
      const node = make("button", { type: "button", class: "cm-find-button", "data-testid": testid }, label);
      node.addEventListener("click", run);
      return node;
    };
    const steps = make("span", { class: "cm-find-group" });
    steps.append(
      button("Previous", () => findPrevious(view), "find-previous"),
      button("Next", () => findNext(view), "find-next"),
      button("All", () => selectMatches(view), "find-all"),
    );
    const toggle = (label: string, key: "caseSensitive" | "wholeWord" | "regexp") => {
      const node = button(label, () => {
        node.setAttribute("aria-pressed", String(node.getAttribute("aria-pressed") !== "true"));
        this.commit();
      }, `find-${key}`);
      node.setAttribute("aria-pressed", String(this.query[key]));
      return node;
    };
    this.toggles = {
      caseSensitive: toggle("Match case", "caseSensitive"),
      wholeWord: toggle("Whole word", "wholeWord"),
      regexp: toggle("Regexp", "regexp"),
    };
    const options = make("span", { class: "cm-find-group" });
    options.append(this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp);
    const close = make("button", { type: "button", class: "cm-find-close", "aria-label": "Close find", title: "Close find" }, "×");
    close.addEventListener("click", () => closeSearchPanel(view));
    this.dom = make("div", { class: "cm-find", role: "search", "data-testid": "find-bar" });
    this.dom.append(this.field, this.count, steps, options, close);
    this.dom.addEventListener("keydown", (e) => this.keydown(e));
    this.recount();
  }

  private commit() {
    const query = new SearchQuery({
      search: this.field.value,
      caseSensitive: this.toggles.caseSensitive.getAttribute("aria-pressed") === "true",
      wholeWord: this.toggles.wholeWord.getAttribute("aria-pressed") === "true",
      regexp: this.toggles.regexp.getAttribute("aria-pressed") === "true",
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  /** Counts now for a small file, after a pause for a large one, or after
      a pause whatever the size. */
  private countSoon(always = false) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!always && this.view.state.doc.length <= LARGE_FILE) {
      this.recount();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recount();
    }, COUNT_AFTER);
  }

  private keydown(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
    } else if (e.key === "Enter" && e.target === this.field) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    }
  }

  /** How many matches there are, or that the text is no expression. */
  private recount() {
    const query = this.query;
    if (query.search === "") {
      this.count.textContent = "";
      return;
    }
    if (!query.valid) {
      this.count.textContent = "Not an expression";
      return;
    }
    let found = 0;
    const cursor = query.getCursor(this.view.state);
    while (found <= MOST_COUNTED && !cursor.next().done) found += 1;
    this.count.textContent =
      found === 0 ? "No matches" : found > MOST_COUNTED ? `${MOST_COUNTED}+ matches` : `${found} ${found === 1 ? "match" : "matches"}`;
  }

  update(update: ViewUpdate) {
    let asked = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (!effect.is(setSearchQuery)) continue;
        asked = true;
        if (effect.value.eq(this.query)) continue;
        this.query = effect.value;
        this.field.value = this.query.search;
        for (const key of ["caseSensitive", "wholeWord", "regexp"] as const) {
          this.toggles[key].setAttribute("aria-pressed", String(this.query[key]));
        }
      }
    }
    if (asked) this.countSoon();
    else if (update.docChanged && this.query.search !== "") this.countSoon(true);
  }

  destroy() {
    if (this.timer !== null) clearTimeout(this.timer);
  }

  mount() {
    this.field.select();
  }
}

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
  search({ top: true, createPanel: (view) => new FindPanel(view) }),
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

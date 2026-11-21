import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { insertNewlineAndIndent, toggleComment } from "@codemirror/commands";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { language, plain, stateFor } from "$lib/codeEditor";
import { colouringOf, languageOf } from "$lib/languages";

/** How many times each language package was loaded. */
const loaded = vi.hoisted(() => ({ rust: 0, python: 0 }));

vi.mock("@codemirror/lang-rust", async (actual) => {
  loaded.rust += 1;
  return actual();
});

vi.mock("@codemirror/lang-python", async (actual) => {
  loaded.python += 1;
  return actual();
});

describe("the language of a file", () => {
  it("is named from the file's extension, or its whole name", () => {
    expect(languageOf("docs/layout.md")).toBe("Markdown");
    expect(languageOf("src/lib/layout.svelte.ts")).toBe("TypeScript");
    expect(languageOf("src/App.TSX")).toBe("TypeScript");
    expect(languageOf("src/main.rs")).toBe("Rust");
    expect(languageOf("cmd/main.go")).toBe("Go");
    expect(languageOf("Cargo.toml")).toBe("TOML");
    expect(languageOf(".github/workflows/ci.yml")).toBe("YAML");
    expect(languageOf("scripts/build.sh")).toBe("Shell");
    expect(languageOf("src/lib/App.svelte")).toBe("Svelte");
    expect(languageOf("Dockerfile")).toBe("Dockerfile");
    expect(languageOf("deploy/Dockerfile")).toBe("Dockerfile");
    expect(languageOf("Dockerfile.dev")).toBe("Dockerfile");
    expect(languageOf("deploy/prod.dockerfile")).toBe("Dockerfile");
    expect(languageOf("Containerfile")).toBe("Dockerfile");
    expect(languageOf(".bashrc")).toBe("Shell");
    expect(languageOf("home/.zshrc")).toBe("Shell");
    expect(languageOf("tsconfig.json")).toBe("JSON");
    expect(languageOf(".vscode/settings.jsonc")).toBe("JSON");
    expect(languageOf("src/App.js")).toBe("JavaScript");
    expect(languageOf("build.gradle.kts")).toBe("Kotlin");
    expect(languageOf("stubs/os.pyi")).toBe("Python");
    expect(languageOf("src/a.cxx")).toBe("C++");
    expect(languageOf("src/a.hxx")).toBe("C++");
    expect(languageOf("src/a.hh")).toBe("C++");
    expect(languageOf("index.htm")).toBe("HTML");
    expect(languageOf("static/logo.svg")).toBe("XML");
  });

  it("is plain text for a name that names none", () => {
    expect(languageOf("LICENSE")).toBe("Plain text");
    expect(languageOf(".gitignore")).toBe("Plain text");
    expect(languageOf("notes.txt")).toBe("Plain text");
    expect(languageOf("Untitled 2")).toBe("Plain text");
    expect(languageOf("archive.tar.zz")).toBe("Plain text");
  });
});

describe("colouring a file", () => {
  it("loads a language only when a file in it is first opened, and once", async () => {
    expect(loaded.rust).toBe(0);
    expect(loaded.python).toBe(0);
    const first = colouringOf("src/main.rs");
    expect(await first).not.toBeNull();
    expect(loaded.rust).toBe(1);
    expect(colouringOf("src/lib.rs")).toBe(first);
    expect(loaded.rust).toBe(1);
    expect(loaded.python).toBe(0);
  });

  it("is plain at once for a language with no colours or no language at all", () => {
    expect(colouringOf("notes.txt")).toBeNull();
    expect(colouringOf("LICENSE")).toBeNull();
    expect(colouringOf("main.tf")).toBeNull();
  });

  it("draws each kind of word in its token's colour", async () => {
    const colouring = await colouringOf("app.py");
    let state = stateFor("def run():\n    return 'done'  # finished\n");
    expect(language.get(state)).toBe(plain);
    state = state.update({ effects: language.reconfigure(colouring!) }).state;
    const view = new EditorView({ state, parent: document.body });
    const colourOf = (word: string) => {
      const span = [...view.contentDOM.querySelectorAll("span")].find((node) => node.textContent === word);
      expect(span, word).toBeDefined();
      const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]) as CSSStyleRule[];
      const rule = rules.find((r) => r.selectorText !== undefined && [...span!.classList].some((name) => r.selectorText === `.${name}`) && r.style.color !== "");
      return rule?.style.color;
    };
    expect(colourOf("def")).toBe("var(--code-keyword)");
    expect(colourOf("'done'")).toBe("var(--code-string)");
    expect(colourOf("# finished")).toBe("var(--code-comment)");
    view.destroy();
  });
});

/** A file's state, coloured as its name says. */
async function coloured(path: string, text: string): Promise<EditorState> {
  const colouring = await colouringOf(path);
  return stateFor(text).update({ effects: language.reconfigure(colouring!) }).state;
}

describe("typing in a coloured file", () => {
  /** What Enter at the bar leaves before the cursor on the new line. */
  async function enter(path: string, text: string): Promise<string> {
    const at = text.indexOf("|");
    let state = (await coloured(path, text.replace("|", ""))).update({ selection: EditorSelection.cursor(at) }).state;
    insertNewlineAndIndent({ state, dispatch: (tr) => (state = tr.state) });
    const line = state.doc.lineAt(state.selection.main.head);
    return line.text.slice(0, state.selection.main.head - line.from);
  }

  it("keeps the indentation of the line Enter leaves", async () => {
    expect(await enter("src/main.rs", "fn main() {\n    let a = 1;|\n}\n")).toBe("    ");
    expect(await enter("src/app.py", "def run():\n    a = 1|\n")).toBe("    ");
  });

  it("gives a tab-indented file spaces, as plain text does", async () => {
    const tabbed = "func main() {\n\ta := 1|\n}\n";
    expect(await enter("cmd/main.go", tabbed)).toBe("    ");
    let state = stateFor(tabbed.replace("|", "")).update({ selection: EditorSelection.cursor(tabbed.indexOf("|")) }).state;
    insertNewlineAndIndent({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.lineAt(state.selection.main.head).text).toBe("    ");
  });

  it("comments a line out in the language's own syntax", async () => {
    let state = await coloured("src/main.rs", "let a = 1;\n");
    toggleComment({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe("// let a = 1;\n");
  });
});

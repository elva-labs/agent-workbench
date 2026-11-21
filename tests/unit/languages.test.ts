import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
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

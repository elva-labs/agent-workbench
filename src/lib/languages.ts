import type { Extension } from "@codemirror/state";
import type { Language, StreamParser } from "@codemirror/language";

/**
 * What a file is written in, by its name: what the editor's foot names and
 * how the editor colours it, from the one table.
 *
 * Each language's parser is loaded the first time a file in it is opened,
 * and the colours with the first of them, so none of it is in what the app
 * starts with. A language with no parser is named and drawn plain.
 *
 * The parsers are CodeMirror's own packages, and its ports of the older
 * modes for languages it has no package for. Each is the language alone,
 * without what its package adds for typing, such as tags closing
 * themselves or Enter continuing a list. Svelte and Vue files are coloured
 * as HTML, which colours their scripts and styles and leaves their own
 * template syntax plain.
 */

interface Kind {
  /** The name the foot shows. */
  name: string;
  /** The endings a file's name takes, lowercase, after the last dot. */
  extensions: readonly string[];
  /** Whole names a file takes, as written. */
  names?: readonly string[];
  /** Loads the language, for one that is coloured. */
  parser?: () => Promise<Language>;
}

/** A language from one of the older modes. */
function legacy(mode: () => Promise<StreamParser<unknown>>): () => Promise<Language> {
  return async () => {
    const [{ StreamLanguage }, parser] = await Promise.all([import("@codemirror/language"), mode()]);
    return StreamLanguage.define(parser);
  };
}

const typescript = () => import("@codemirror/lang-javascript").then(({ typescriptLanguage }) => typescriptLanguage);
const html = () => import("@codemirror/lang-html").then(({ htmlLanguage }) => htmlLanguage);
const cpp = () => import("@codemirror/lang-cpp").then(({ cppLanguage }) => cppLanguage);

/** Markdown, with a fenced block coloured as the language it names, which
    is loaded when a block first names it. */
async function markdown(): Promise<Language> {
  const [{ markdown, markdownLanguage }, { LanguageDescription, LanguageSupport }] = await Promise.all([
    import("@codemirror/lang-markdown"),
    import("@codemirror/language"),
  ]);
  const codeLanguages = KINDS.flatMap(({ name, extensions, parser }) =>
    parser === undefined
      ? []
      : [
          LanguageDescription.of({
            name,
            alias: [name.toLowerCase(), ...extensions],
            load: async () => new LanguageSupport(await parser()),
          }),
        ],
  );
  return markdown({ base: markdownLanguage, codeLanguages }).language;
}

const KINDS: readonly Kind[] = [
  { name: "Markdown", extensions: ["md", "markdown"], parser: markdown },
  { name: "TypeScript", extensions: ["ts", "mts", "cts"], parser: typescript },
  {
    name: "TypeScript",
    extensions: ["tsx"],
    parser: () => import("@codemirror/lang-javascript").then(({ tsxLanguage }) => tsxLanguage),
  },
  {
    name: "JavaScript",
    extensions: ["js", "mjs", "cjs"],
    parser: () => import("@codemirror/lang-javascript").then(({ javascriptLanguage }) => javascriptLanguage),
  },
  {
    name: "JavaScript",
    extensions: ["jsx"],
    parser: () => import("@codemirror/lang-javascript").then(({ jsxLanguage }) => jsxLanguage),
  },
  { name: "Svelte", extensions: ["svelte"], parser: html },
  { name: "Vue", extensions: ["vue"], parser: html },
  { name: "Rust", extensions: ["rs"], parser: () => import("@codemirror/lang-rust").then(({ rustLanguage }) => rustLanguage) },
  { name: "Go", extensions: ["go"], parser: () => import("@codemirror/lang-go").then(({ goLanguage }) => goLanguage) },
  {
    name: "Python",
    extensions: ["py"],
    parser: () => import("@codemirror/lang-python").then(({ pythonLanguage }) => pythonLanguage),
  },
  { name: "Ruby", extensions: ["rb"], parser: legacy(() => import("@codemirror/legacy-modes/mode/ruby").then(({ ruby }) => ruby)) },
  { name: "Java", extensions: ["java"], parser: () => import("@codemirror/lang-java").then(({ javaLanguage }) => javaLanguage) },
  {
    name: "Kotlin",
    extensions: ["kt"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/clike").then(({ kotlin }) => kotlin)),
  },
  {
    name: "Swift",
    extensions: ["swift"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/swift").then(({ swift }) => swift)),
  },
  { name: "C", extensions: ["c", "h"], parser: cpp },
  { name: "C++", extensions: ["cc", "cpp", "hpp"], parser: cpp },
  {
    name: "C#",
    extensions: ["cs"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/clike").then(({ csharp }) => csharp)),
  },
  {
    name: "JSON",
    extensions: ["json", "jsonc"],
    parser: () => import("@codemirror/lang-json").then(({ jsonLanguage }) => jsonLanguage),
  },
  {
    name: "TOML",
    extensions: ["toml"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/toml").then(({ toml }) => toml)),
  },
  { name: "YAML", extensions: ["yaml", "yml"], parser: () => import("@codemirror/lang-yaml").then(({ yamlLanguage }) => yamlLanguage) },
  { name: "XML", extensions: ["xml"], parser: () => import("@codemirror/lang-xml").then(({ xmlLanguage }) => xmlLanguage) },
  { name: "HTML", extensions: ["html"], parser: html },
  { name: "CSS", extensions: ["css"], parser: () => import("@codemirror/lang-css").then(({ cssLanguage }) => cssLanguage) },
  {
    name: "SCSS",
    extensions: ["scss"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/css").then(({ sCSS }) => sCSS)),
  },
  { name: "SQL", extensions: ["sql"], parser: () => import("@codemirror/lang-sql").then(({ StandardSQL }) => StandardSQL.language) },
  {
    name: "Shell",
    extensions: ["sh", "bash", "zsh"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/shell").then(({ shell }) => shell)),
  },
  {
    name: "PowerShell",
    extensions: ["ps1"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/powershell").then(({ powerShell }) => powerShell)),
  },
  { name: "Terraform", extensions: ["tf"] },
  { name: "Lua", extensions: ["lua"], parser: legacy(() => import("@codemirror/legacy-modes/mode/lua").then(({ lua }) => lua)) },
  { name: "PHP", extensions: ["php"] },
  {
    name: "Dockerfile",
    extensions: [],
    names: ["Dockerfile"],
    parser: legacy(() => import("@codemirror/legacy-modes/mode/dockerfile").then(({ dockerFile }) => dockerFile)),
  },
  { name: "Makefile", extensions: [], names: ["Makefile"] },
];

/** The language a file's name says it is in, if any. */
function kindOf(path: string): Kind | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const named = KINDS.find((kind) => kind.names?.includes(name));
  if (named !== undefined) return named;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return KINDS.find((kind) => kind.extensions.includes(extension)) ?? null;
}

/** What a file is written in, by its name, for the editor's foot. */
export function languageOf(path: string): string {
  return kindOf(path)?.name ?? "Plain text";
}

/** Each language as it loads, so it is loaded once. */
const loads = new Map<Kind, Promise<Extension | null>>();

/**
 * How the editor colours a file: its language and the colours, once both
 * have loaded, or null for a file drawn plain, at once when its name names
 * no coloured language. A language that fails to load is drawn plain and
 * tried again for the next file in it.
 */
export function colouringOf(path: string): Promise<Extension | null> | null {
  const kind = kindOf(path);
  if (kind?.parser === undefined) return null;
  let load = loads.get(kind);
  if (load === undefined) {
    load = Promise.all([kind.parser(), import("./highlight")]).then(
      ([language, { highlight }]): Extension => [language, highlight],
      () => {
        loads.delete(kind);
        return null;
      },
    );
    loads.set(kind, load);
  }
  return load;
}

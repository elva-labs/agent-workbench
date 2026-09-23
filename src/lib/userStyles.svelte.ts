/**
 * The user's own stylesheet, laid over the app's when the settings say so.
 *
 * The core keeps the sheet in a file beside the settings and hands it over
 * only once it loads nothing from anywhere; one that would comes with the
 * reason instead, which the settings show. The window writes the sheet into
 * the page last, so it can restyle anything, and takes it out again while
 * the app is asking the user something or the settings are open: a sheet
 * can dress anything up, a question included, and a question has to read
 * as what it is. The settings being plain is also the way back from a
 * sheet that has made the rest hard to use.
 *
 * The rules a sheet is held to are the core's, in the same words; the
 * window reads them to tell an agent why a sheet will not do before the
 * user is asked about it.
 */

import { core, type UserStyles } from "$lib/core";
import { persist } from "$lib/persist";

export const userStyles = $state({
  /** The sheet, as the core handed it over. */
  css: "",
  /** Why the sheet on disk was not handed over, when it was not. */
  problem: null as string | null,
  /** The setting: whether the sheet is laid over the app's. */
  on: false,
});

export const MOST_BYTES = 256 * 1024;

/** The window's copy, for the first frame of a start: the sheet as it was
    last handed over, and whether it was on. */
const KEY = "workbench.userStyles";

function remember() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on: userStyles.on, css: userStyles.css }));
  } catch {
    // Non-fatal: the next start shows the sheet once the core answers.
  }
}

/** Reads the window's copy. The core's word replaces it when it comes. */
export function loadUserStyles() {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (kept === null || typeof kept !== "object") return;
    const { on, css } = kept as { on?: unknown; css?: unknown };
    if (typeof css === "string" && styleProblem(css) === null) userStyles.css = css;
    userStyles.on = on === true;
  } catch {
    // A copy that does not read is no copy.
  }
}

const IDENT = /[a-z0-9_-]/;
const PREFIXES = ["-webkit-", "-moz-", "-o-", "-ms-"];

function uncommented(css: string): string {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
}

/** Where a function of this name is called: the name standing on its own,
    or behind a vendor's prefix, and not the tail of a longer name. */
function calls(text: string, name: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const head = text.slice(0, at);
    const own = head === "" || !IDENT.test(head[head.length - 1]);
    if (own || PREFIXES.some((prefix) => head.endsWith(prefix))) found.push(at);
  }
  return found;
}

/** Why a sheet may not be used, or null when it may. */
export function styleProblem(css: string): string | null {
  if (new TextEncoder().encode(css).length > MOST_BYTES) {
    return `the stylesheet is ${Math.floor(new TextEncoder().encode(css).length / 1024)} KB; it may be ${MOST_BYTES / 1024} KB at most`;
  }
  if (css.includes("\\")) {
    return "the stylesheet has a backslash in it. Escapes are not taken, since they can spell a url where none can be seen; write the character itself";
  }
  const text = uncommented(css).toLowerCase();
  if (text.includes("@import")) {
    return "the stylesheet imports another. It may load nothing from anywhere";
  }
  for (const name of ["image-set(", "src(", "image("]) {
    if (calls(text, name).length > 0) {
      return `the stylesheet uses ${name}), which loads an address. It may load nothing from anywhere`;
    }
  }
  for (const at of calls(text, "url(")) {
    const after = text
      .slice(at + 4)
      .trimStart()
      .replace(/^["']+/, "");
    if (!after.startsWith("data:") && !after.startsWith("#")) {
      return "the stylesheet has a url() that is not a data: url. It may load nothing from anywhere";
    }
  }
  return null;
}

/** Takes what the core handed over. */
export function adoptStyles(styles: UserStyles) {
  userStyles.css = styles.css ?? "";
  userStyles.problem = styles.problem ?? null;
  remember();
}

/** Takes the setting from the core's settings. Nothing is sent back. */
export function adoptUserStylesSetting(on: boolean | undefined) {
  userStyles.on = on === true;
  remember();
}

/** Lays the sheet over the app's, or takes it off. */
export function setUserStyles(on: boolean) {
  userStyles.on = on;
  remember();
  persist({ userStyles: on });
}

/** Follows the core's sheet for as long as the window is open. */
export async function followStyles(): Promise<() => void> {
  let stop = () => {};
  try {
    stop = await core().onStylesChanged(adoptStyles);
    adoptStyles(await core().stylesGet());
  } catch {
    // No core to keep a sheet: there is none.
  }
  return stop;
}

/** Writes the sheet into the page, or takes it out, as `shown` says.
    Answers whether the page changed. */
export function paintStyles(shown: boolean): boolean {
  const id = "workbench-user-styles";
  let sheet = document.getElementById(id) as HTMLStyleElement | null;
  if (sheet === null) {
    sheet = document.createElement("style");
    sheet.id = id;
  }
  // Last in the head, after the app's own sheets and the themes'.
  if (sheet.parentNode !== document.head || document.head.lastElementChild !== sheet) {
    document.head.appendChild(sheet);
  }
  const css = shown ? userStyles.css : "";
  if (sheet.textContent === css) return false;
  sheet.textContent = css;
  return true;
}

/** Test seam. */
export function resetUserStyles() {
  userStyles.css = "";
  userStyles.problem = null;
  userStyles.on = false;
}

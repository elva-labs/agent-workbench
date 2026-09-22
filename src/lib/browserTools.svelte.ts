/**
 * The tools an agent drives the embedded browser with.
 *
 * The core carries a call on one of the browser's tools to the window as a
 * request; the window performs it against the native browser and answers
 * with the result or the reason it could not be done, the same way it
 * answers a conductor's call. Every call is answered exactly once: the
 * agent on the other side is blocked until it is.
 */

import { core, type BrowserRequest, type BrowserTab } from "$lib/core";
import { activate as activateTab, activeTab, browser } from "$lib/browser.svelte";
import { showBrowser } from "$lib/files.svelte";

/** The ids of the calls handled lately, so a call delivered twice is
    handled once. */
const seen = new Set<string>();
const SEEN = 500;

interface Answered {
  content: string | null;
  error: string | null;
}

const said = (content: string): Answered => ({ content, error: null });
const refused = (error: string): Answered => ({ content: null, error });

/**
 * Answers one call. Every call is answered exactly once, whatever happens:
 * the agent on the other side is blocked until it is.
 */
export async function handle(request: BrowserRequest): Promise<void> {
  // An app and a daemon sharing a home both read the same log, and both
  // deliver the call: the second copy is the same call, not another.
  if (seen.has(request.id)) return;
  seen.add(request.id);
  if (seen.size > SEEN) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  let answered: Answered;
  try {
    answered = await run(request);
  } catch (error) {
    answered = refused(String(error));
  }
  await core()
    .browserAnswer(request.id, request.cwd, answered.content, answered.error)
    .catch(() => {
      // The core has gone, or the call had already given up. Nothing here
      // can tell the agent either way.
    });
}

function run(request: BrowserRequest): Answered | Promise<Answered> {
  switch (request.tool) {
    case "browser_open":
      return openBrowserTool(request);
    case "browser_tabs":
      return said(tabLines());
    case "browser_navigate":
      return navigateTool(request);
    case "browser_snapshot":
      return snapshotTool(request);
    case "browser_click":
      return clickTool(request);
    case "browser_type":
      return typeTool(request);
    case "browser_console":
      return consoleTool(request);
    case "browser_screenshot":
      return screenshotTool(request);
    case "browser_eval":
      return evalTool(request);
    case "browser_close":
      return closeTool(request);
    default:
      return refused(`The workbench has no ${String(request.tool)} tool.`);
  }
}

async function openBrowserTool(request: BrowserRequest): Promise<Answered> {
  const url = text(request, "url");
  if (url === null) return refused("Opening a tab needs a url.");
  // Goes through the core directly, not through browser.svelte's own open():
  // that keeps its rejection on a store field meant for the address bar's
  // one attempt at a time, which two calls landing together would race on.
  let snapshot;
  try {
    snapshot = await core().browserOpen(url, request.session);
  } catch (error) {
    return refused(String(error));
  }
  browser.tabs = snapshot.tabs;
  browser.active = snapshot.active;
  showBrowser();
  const tab = activeTab();
  if (tab === null) return refused("The tab could not be opened.");
  return arrived("Opened", await settled(tab.id), tab.id);
}

/** The tabs, one line each: id, url, title, and whether it is active,
    loading or in error. */
function tabLines(): string {
  if (browser.tabs.length === 0) return "No tabs are open.";
  return browser.tabs
    .map((tab) => {
      const parts = [String(tab.id), tab.url, tab.title || "(no title)"];
      if (tab.id === browser.active) parts.push("active");
      if (tab.loading) parts.push("loading");
      if (tab.error !== null) parts.push(`error: ${tab.error}`);
      return parts.join("  ");
    })
    .join("\n");
}

/** The tab a call names, or the active one when it names none. Null when
    there is no such tab to act on. */
function resolveTab(request: BrowserRequest): BrowserTab | null {
  const id = numberArg(request, "tab");
  if (id === null) return activeTab();
  return browser.tabs.find((tab) => tab.id === id) ?? null;
}

/** Why `resolveTab` found nothing: a named tab that is not open, or, with
    none named, that none is open at all. */
function noTabMessage(request: BrowserRequest): string {
  const id = numberArg(request, "tab");
  return id === null ? "No tab is open." : `The workbench has no tab ${id}.`;
}

async function navigateTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  const url = text(request, "url");
  const action = text(request, "action");
  if (url !== null && action !== null)
    return refused("Give navigate a url or an action, not both.");
  try {
    if (url !== null) {
      await core().browserNavigate(tab.id, url);
    } else if (action === "back") {
      await core().browserBack(tab.id);
    } else if (action === "forward") {
      await core().browserForward(tab.id);
    } else if (action === "reload") {
      await core().browserReload(tab.id);
    } else {
      return refused(
        "Navigate needs a url, or an action of back, forward or reload.",
      );
    }
  } catch (error) {
    return refused(String(error));
  }
  return arrived("Navigated", await settled(tab.id), tab.id);
}

async function snapshotTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  try {
    return said(await core().browserSnapshot(tab.id));
  } catch (error) {
    return refused(String(error));
  }
}

async function clickTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  const ref = text(request, "ref");
  if (ref === null)
    return refused("Clicking needs a ref, from browser_snapshot.");
  try {
    await core().browserClick(tab.id, ref);
  } catch (error) {
    return refused(String(error));
  }
  return said(`Clicked ${ref} in tab ${tab.id}.`);
}

async function typeTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  const ref = text(request, "ref");
  if (ref === null)
    return refused("Typing needs a ref, from browser_snapshot.");
  const value = request.arguments.text;
  if (typeof value !== "string")
    return refused("Typing needs the text to type.");
  const submit = request.arguments.submit === true;
  try {
    await core().browserType(tab.id, ref, value, submit);
  } catch (error) {
    return refused(String(error));
  }
  return said(`Typed into ${ref} in tab ${tab.id}.`);
}

async function consoleTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  try {
    const entries = await core().browserConsole(tab.id);
    if (entries.length === 0) return said("The console is empty.");
    return said(
      entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n"),
    );
  } catch (error) {
    return refused(String(error));
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long a tab has to finish loading before a call answers anyway. */
const SETTLE = 10_000;

/** The tab once it has stopped loading, so the agent's next call reads the
    page it asked for and not the one before it. A timer and not a frame,
    since a window out of sight gets no frames. Null when the tab has gone. */
async function settled(id: number): Promise<BrowserTab | null> {
  // A navigation takes a moment to be reported as under way.
  await wait(150);
  const until = Date.now() + SETTLE;
  for (;;) {
    const tab = browser.tabs.find((candidate) => candidate.id === id) ?? null;
    if (tab === null || !tab.loading || Date.now() >= until) return tab;
    await wait(100);
  }
}

/** Where a tab stands, for the answer to a call that sent it somewhere. */
function arrived(verb: string, tab: BrowserTab | null, id: number): Answered {
  if (tab === null) return refused(`Tab ${id} closed before it loaded.`);
  if (tab.error !== null)
    return refused(`Tab ${id} did not load ${tab.url}: ${tab.error}.`);
  const title = tab.title === "" ? "" : `, ${tab.title}`;
  const still = tab.loading ? " (still loading)" : "";
  return said(`${verb} tab ${tab.id}: ${tab.url}${title}${still}`);
}

async function screenshotTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  showBrowser();
  if (tab.id !== browser.active) await activateTab(tab.id);
  // The view is placed as soon as the viewer shows the tab; a moment is
  // left for it to land and paint.
  await wait(250);
  try {
    return said(await core().browserScreenshot(tab.id));
  } catch (error) {
    return refused(String(error));
  }
}

async function evalTool(request: BrowserRequest): Promise<Answered> {
  const tab = resolveTab(request);
  if (tab === null) return refused(noTabMessage(request));
  const script = text(request, "script");
  if (script === null) return refused("Running a script needs its body.");
  try {
    return said(await core().browserEval(tab.id, script));
  } catch (error) {
    return refused(String(error));
  }
}

async function closeTool(request: BrowserRequest): Promise<Answered> {
  const id = numberArg(request, "tab");
  if (id === null) return refused("Closing needs a tab.");
  const tab = browser.tabs.find((candidate) => candidate.id === id) ?? null;
  if (tab === null) return refused(`The workbench has no tab ${id}.`);
  await core().browserClose(id);
  return said(`Closed tab ${id}.`);
}

/** A string argument, trimmed. Null when it is missing or empty. */
function text(request: BrowserRequest, name: string): string | null {
  const value = request.arguments[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A whole-number argument, such as a tab id. Null when it is missing. */
function numberArg(request: BrowserRequest, name: string): number | null {
  const value = request.arguments[name];
  return typeof value === "number" ? value : null;
}

/** Test seam. */
export function resetBrowserTools() {
  seen.clear();
}

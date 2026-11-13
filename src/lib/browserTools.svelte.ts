/**
 * The tools an agent drives the embedded browser with.
 *
 * The core carries a call on one of the browser's tools to the window as a
 * request; the window performs it against the native browser and answers
 * with the result or the reason it could not be done, the same way it
 * answers a conductor's call. Every call is answered exactly once: the
 * agent on the other side is blocked until it is.
 */

import {
  core,
  type BrowserOwner,
  type BrowserRequest,
  type BrowserTab,
} from "$lib/core";
import {
  activate as activateTab,
  applySnapshot,
  browser,
  closeOwner,
  ownerOnScreen,
  ownerOpen,
  sameOwner,
  syncOwner,
} from "$lib/browser.svelte";
import { showBrowser } from "$lib/files.svelte";
import { byKey, sessions } from "$lib/sessions.svelte";
import { held, projectOf, sessionFor } from "$lib/show.svelte";

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
  // Every tool acts within one owner's tabs, so a call that has none gets
  // nothing, whatever the tool.
  const whose = ownerFor(request);
  if ("refusal" in whose) return refused(whose.refusal);
  switch (request.tool) {
    case "browser_open":
      return openBrowserTool(request);
    case "browser_tabs":
      return said(tabLines(request));
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
  // The tab opens and loads either way, for the calling session. From the
  // session on screen it comes to the front and the viewer shows the
  // browser now; from another it is that session's front tab behind
  // whatever the user has in front, and the viewer shows it when they
  // switch to the session, as the show tool's place does.
  const owner = ownerOf(request);
  if (owner === null) return refused(noOwner);
  // The core has to know whose tabs are on screen before a tab is opened
  // for them, or it would not know whether to show it.
  await syncOwner();
  if (!ownerOpen(owner)) return refused(gone);
  // Goes through the core directly, not through browser.svelte's own open():
  // that keeps its rejection on a store field meant for the address bar's
  // one attempt at a time, which two calls landing together would race on.
  let snapshot;
  try {
    snapshot = await core().browserOpen(url, owner, true);
  } catch (error) {
    return refused(String(error));
  }
  applySnapshot(snapshot);
  // The session or project closed while the tab was opening: nothing is
  // left to own it.
  if (!ownerOpen(owner)) {
    await closeOwner(owner);
    return refused(gone);
  }
  // Tabs come in opening order: the new one is last.
  const tab = snapshot.tabs[snapshot.tabs.length - 1] ?? null;
  if (tab === null) return refused("The tab could not be opened.");
  const reveal = async () => {
    const now = browser.tabs.find((candidate) => candidate.id === tab.id);
    if (now === undefined || !sameOwner(now.owner, ownerOnScreen())) return;
    if (!now.front) await activateTab(tab.id);
    showBrowser();
  };
  // Held only once the tab is open: a failed open displaces nothing the
  // session's agent asked to show before it. Who is on screen is read again
  // here, since the user may have switched while the tab opened. A session
  // that is not on screen has the viewer shown when the user switches to
  // it; a tab owned by a project is its front tab, and the viewer is left
  // as it is.
  if (sameOwner(owner, ownerOnScreen())) await reveal();
  else if (owner.kind === "session") {
    const row = byKey(owner.key);
    if (row !== null) held(request, row.project, reveal);
  }
  return arrived("Opened", await settled(tab.id), tab.id);
}

const noOwner = "No project the workbench has open runs here.";
const gone = "The session or project this call is from has closed.";

/** Whose tabs a call acts on: the session it is from, else the project it
    runs in. A call from outside every open project, or from a session the
    window has no row for, has no owner and is refused. */
function ownerFor(
  request: BrowserRequest,
): { owner: BrowserOwner } | { refusal: string } {
  const project = projectOf(request.cwd);
  if (project === null) return { refusal: noOwner };
  // A session id names a row anywhere in the window, so a session working
  // in a project nested inside another open one is found too.
  const named =
    request.session === null
      ? null
      : (sessions.all.find((session) => session.id === request.session) ??
        null);
  if (request.session !== null && named === null)
    return { refusal: "That session is not open in the workbench." };
  const session = named ?? sessionFor(request, project);
  if (session !== null)
    return { owner: { kind: "session", key: session.key } };
  return { owner: { kind: "project", path: project } };
}

function ownerOf(request: BrowserRequest): BrowserOwner | null {
  const whose = ownerFor(request);
  return "owner" in whose ? whose.owner : null;
}

/** The tabs the call's owner has, in opening order. */
function ownTabs(request: BrowserRequest): BrowserTab[] {
  const owner = ownerOf(request);
  return browser.tabs.filter((tab) => sameOwner(tab.owner, owner));
}

/** The tabs of the calling session, one line each: id, url, title, and
    whether it is in front, loading or in error. */
function tabLines(request: BrowserRequest): string {
  const own = ownTabs(request);
  if (own.length === 0) return "No tabs are open.";
  return own
    .map((tab) => {
      const parts = [String(tab.id), tab.url, tab.title || "(no title)"];
      if (tab.front) parts.push("active");
      if (tab.loading) parts.push("loading");
      if (tab.error !== null) parts.push(`error: ${tab.error}`);
      return parts.join("  ");
    })
    .join("\n");
}

/** The tab a call names, or, when it names none, the calling session's
    front tab. A tab another session owns is refused, as is one that is not
    open. */
function resolveTab(
  request: BrowserRequest,
): { tab: BrowserTab } | { refusal: string } {
  const id = numberArg(request, "tab");
  if (id === null) {
    const front = ownTabs(request).find((tab) => tab.front);
    return front === undefined
      ? { refusal: "No tab is open." }
      : { tab: front };
  }
  const tab = browser.tabs.find((candidate) => candidate.id === id);
  if (tab === undefined) return { refusal: `The workbench has no tab ${id}.` };
  if (!sameOwner(tab.owner, ownerOf(request)))
    return { refusal: `Tab ${id} belongs to another session.` };
  return { tab };
}

async function navigateTool(request: BrowserRequest): Promise<Answered> {
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
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
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
  try {
    return said(await core().browserSnapshot(tab.id));
  } catch (error) {
    return refused(String(error));
  }
}

async function clickTool(request: BrowserRequest): Promise<Answered> {
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
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
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
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
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
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
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
  // A new tab and a page that failed are drawn by the viewer, not by the
  // tab's own view, so its image would be blank.
  if (tab.error !== null)
    return refused(`Tab ${tab.id} did not load ${tab.url}: ${tab.error}.`);
  if (tab.url === "about:blank" || tab.url === "")
    return refused(`Tab ${tab.id} is a new tab with no page open in it.`);
  // The core captures the tab where it is, whatever the user is looking
  // at, so nothing in front of them changes.
  try {
    return said(await core().browserScreenshot(tab.id));
  } catch (error) {
    return refused(String(error));
  }
}

async function evalTool(request: BrowserRequest): Promise<Answered> {
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
  const tab = found.tab;
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
  const found = resolveTab(request);
  if ("refusal" in found) return refused(found.refusal);
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

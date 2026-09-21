/**
 * The embedded browser, as the frontend keeps it: the open tabs, which one
 * is active, whether the viewer is showing it at all, and the last address
 * that was refused.
 *
 * The native view for the active tab is a child webview the Rust side lays
 * over a rectangle on the window; this store only says where that rectangle
 * is and whether the view belongs there at all. A tab drawn empty, its url
 * `about:blank`, is a new tab the frontend draws its own page for, and the
 * native view stays out of the way while one is active.
 *
 * Geometry can change faster than the core can place it: a resize fires
 * more than once a frame. `place` keeps only the newest rectangle waiting
 * behind whichever placement is already in flight, since two `browser_place`
 * calls sent together can land in either order and a stale one landing last
 * would misplace the view.
 *
 * The native view floats above the page, so anything the app draws over the
 * viewer's body would be covered by it. `cover` hides the view for as long
 * as something is drawn there, a menu or a dialog, and puts it back at its
 * last rectangle once the last cover lifts.
 */

import { core, type BrowserSnapshot, type BrowserTab } from "$lib/core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const browser = $state({
  tabs: [] as BrowserTab[],
  active: null as number | null,
  /** Whether the viewer is showing the browser at all, apart from whether
      the active tab's native view is actually visible: a new tab keeps that
      hidden even while this is true. */
  showing: false,
  /** The last rejection from navigate or open. Cleared on the next attempt
      and when the active tab changes. */
  addressError: null as string | null,
  /** Something is drawn above the viewer's body right now, a menu or a
      dialog, that the native view would otherwise show through. The view
      is hidden while this is true, the way it is for a new tab. */
  covered: false,
});

/** The tab in front, or null with none open. */
export function activeTab(): BrowserTab | null {
  return browser.tabs.find((tab) => tab.id === browser.active) ?? null;
}

/** A tab's label: its title, its host until it has one, or "New tab" while
    it holds no address yet. */
export function titleFor(tab: BrowserTab): string {
  if (tab.title !== "") return tab.title;
  if (tab.url === "about:blank" || tab.url === "") return "New tab";
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

function applySnapshot(snapshot: BrowserSnapshot) {
  const activeChanged = browser.active !== snapshot.active;
  browser.tabs = snapshot.tabs;
  browser.active = snapshot.active;
  if (activeChanged) browser.addressError = null;
}

/** Opens a tab: a url, or none for a new tab. A url that cannot be reached
    leaves the tabs as they were and says why. */
export async function open(url?: string, session?: string) {
  browser.addressError = null;
  try {
    applySnapshot(await core().browserOpen(url ?? null, session ?? null));
  } catch (error) {
    browser.addressError = String(error);
  }
}

export async function close(id: number) {
  applySnapshot(await core().browserClose(id));
}

export async function activate(id: number) {
  applySnapshot(await core().browserActivate(id));
}

/** Navigates the active tab, or opens one at the address when there is
    none open yet. */
export async function navigate(address: string) {
  browser.addressError = null;
  const tab = activeTab();
  if (tab === null) {
    await open(address);
    return;
  }
  try {
    await core().browserNavigate(tab.id, address);
  } catch (error) {
    browser.addressError = String(error);
  }
}

export async function back() {
  const tab = activeTab();
  if (tab !== null) await core().browserBack(tab.id);
}

export async function forward() {
  const tab = activeTab();
  if (tab !== null) await core().browserForward(tab.id);
}

export async function reload() {
  const tab = activeTab();
  if (tab !== null) await core().browserReload(tab.id);
}

export async function home() {
  const tab = activeTab();
  if (tab !== null) await core().browserHome(tab.id);
}

export function show() {
  browser.showing = true;
}

let queued: Rect | "hide" | null = null;
let sending = false;
/** The rectangle last actually sent, null once the view is known hidden, so
    a rectangle equal to it is skipped and a hide is not sent twice running. */
let placed: Rect | null = null;
/** The rectangle last asked for, whether or not it was actually sent, so a
    cover that lifts can put the view back where it was without waiting for
    the next resize. */
let lastRect: Rect | null = null;
let coverCount = 0;

function sameRect(a: Rect, b: Rect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** Sends whatever is queued, one call at a time, taking the newest waiting
    rectangle each time it is free again. */
async function pump() {
  if (sending) return;
  sending = true;
  try {
    while (queued !== null) {
      const next = queued;
      queued = null;
      try {
        if (next === "hide") {
          if (placed === null) continue;
          placed = null;
          await core().browserHide();
        } else {
          await core().browserPlace(next.x, next.y, next.width, next.height);
          placed = next;
        }
      } catch {
        // Where the view is now is unknown, so the next rectangle is sent
        // whatever it is, and what is waiting still goes.
        placed = null;
      }
    }
  } finally {
    sending = false;
  }
}

/** Whether the active tab's native view belongs on screen at all: the
    viewer is showing the browser, nothing covers it, and the active tab is
    a page that loaded: a new tab and a page that failed are drawn by the
    viewer itself. */
function shouldShow(): boolean {
  const tab = activeTab();
  return (
    browser.showing &&
    !browser.covered &&
    tab !== null &&
    tab.url !== "about:blank" &&
    tab.error === null
  );
}

/** Where the active tab's native view goes, in logical pixels relative to
    the window's viewport. Skips a rectangle equal to the one already
    placed, and hides the view instead of placing it while there is no tab
    to show it for, the viewer is not showing the browser, or something
    covers it. */
export function place(rect: Rect) {
  lastRect = rect;
  if (!shouldShow()) {
    queued = "hide";
    void pump();
    return;
  }
  if (placed !== null && sameRect(rect, placed)) return;
  queued = rect;
  void pump();
}

export function hide() {
  browser.showing = false;
  queued = "hide";
  void pump();
}

/**
 * Hides the native view while something is drawn above the viewer's body,
 * a menu opening or a dialog coming up, and returns the function that lifts
 * it. Covers nest: the view stays hidden until as many `uncover`s have run
 * as `cover`s were taken, and only the last one puts the view back, at the
 * last rectangle it was asked to sit at.
 */
export function cover(): () => void {
  coverCount += 1;
  browser.covered = true;
  queued = "hide";
  void pump();

  let lifted = false;
  return () => {
    if (lifted) return;
    lifted = true;
    coverCount = Math.max(0, coverCount - 1);
    if (coverCount > 0) return;
    browser.covered = false;
    if (lastRect !== null) place(lastRect);
  };
}

let initialized = false;

/** Subscribes to the tabs event once, and loads what is open already. Call
    once, from the page. */
export async function initBrowser() {
  if (initialized) return;
  initialized = true;
  await core().onBrowserTabs((snapshot) => applySnapshot(snapshot));
  try {
    applySnapshot(await core().browserTabs());
  } catch {
    // No core to ask: the browser starts with nothing open.
  }
}

/** Test seam. */
export function resetBrowser() {
  browser.tabs = [];
  browser.active = null;
  browser.showing = false;
  browser.addressError = null;
  browser.covered = false;
  queued = null;
  sending = false;
  placed = null;
  lastRect = null;
  coverCount = 0;
  initialized = false;
}

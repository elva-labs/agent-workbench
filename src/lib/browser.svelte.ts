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
});

/** The tab in front, or null with none open. */
export function activeTab(): BrowserTab | null {
  return browser.tabs.find((tab) => tab.id === browser.active) ?? null;
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
    viewer is showing the browser, and the active tab is not a new tab. */
function shouldShow(): boolean {
  const tab = activeTab();
  return browser.showing && tab !== null && tab.url !== "about:blank";
}

/** Where the active tab's native view goes, in logical pixels relative to
    the window's viewport. Skips a rectangle equal to the one already
    placed, and hides the view instead of placing it while there is no tab
    to show it for or the viewer is not showing the browser. */
export function place(rect: Rect) {
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
  queued = null;
  sending = false;
  placed = null;
  initialized = false;
}

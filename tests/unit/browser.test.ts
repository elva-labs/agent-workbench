import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTab } from "$lib/core";

type Rect = { x: number; y: number; width: number; height: number };
type Pending =
  | { kind: "place"; rect: Rect; resolve: () => void; reject: (e: Error) => void }
  | { kind: "hide"; resolve: () => void };

const opened: { url: string | null; session: string | null }[] = [];
const closed: number[] = [];
const activated: number[] = [];
const navigated: { id: number; address: string }[] = [];
const placeLog: Rect[] = [];
let hideCount = 0;
let pending: Pending[] = [];
let tabsHandler: ((snapshot: unknown) => void) | null = null;

let openError: string | null = null;
let openResult: unknown = { tabs: [], active: null };
let navigateError: string | null = null;
let nextSnapshot: unknown = { tabs: [], active: null };
let tabsSnapshot: unknown = { tabs: [], active: null };

/** Resolves the oldest `browser_place` or `browser_hide` call still
    waiting, then lets its continuation run before the test looks again. */
async function resolveNext() {
  const next = pending.shift();
  if (next === undefined) throw new Error("nothing pending");
  next.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock("$lib/core", () => ({
  core: () => ({
    browserOpen: async (url: string | null, session: string | null) => {
      opened.push({ url, session });
      if (openError !== null) throw new Error(openError);
      return openResult;
    },
    browserClose: async (id: number) => {
      closed.push(id);
      return nextSnapshot;
    },
    browserActivate: async (id: number) => {
      activated.push(id);
      return nextSnapshot;
    },
    browserNavigate: async (id: number, address: string) => {
      navigated.push({ id, address });
      if (navigateError !== null) throw new Error(navigateError);
    },
    browserBack: async () => {},
    browserForward: async () => {},
    browserReload: async () => {},
    browserHome: async () => {},
    browserPlace: (x: number, y: number, width: number, height: number) => {
      const rect = { x, y, width, height };
      placeLog.push(rect);
      return new Promise<void>((resolve, reject) => {
        pending.push({ kind: "place", rect, resolve, reject });
      });
    },
    browserHide: () => {
      hideCount += 1;
      return new Promise<void>((resolve) => {
        pending.push({ kind: "hide", resolve });
      });
    },
    browserTabs: async () => tabsSnapshot,
    onBrowserTabs: async (handler: (snapshot: unknown) => void) => {
      tabsHandler = handler;
      return () => {};
    },
  }),
}));

import {
  activate,
  activeTab,
  browser,
  close,
  hide,
  initBrowser,
  navigate,
  open,
  place,
  resetBrowser,
  show,
} from "$lib/browser.svelte";

function tab(id: number, url: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    url,
    title: "",
    home: url,
    opener: { kind: "user" },
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetBrowser();
  opened.length = 0;
  closed.length = 0;
  activated.length = 0;
  navigated.length = 0;
  placeLog.length = 0;
  hideCount = 0;
  pending = [];
  tabsHandler = null;
  openError = null;
  openResult = { tabs: [], active: null };
  navigateError = null;
  nextSnapshot = { tabs: [], active: null };
  tabsSnapshot = { tabs: [], active: null };
});

const RECT_A = { x: 0, y: 0, width: 100, height: 100 };
const RECT_B = { x: 0, y: 0, width: 200, height: 100 };
const RECT_C = { x: 0, y: 0, width: 300, height: 100 };

describe("the placement queue", () => {
  it("sends one placement at a time, keeping only the newest waiting", async () => {
    browser.tabs = [tab(1, "https://example.com/")];
    browser.active = 1;
    show();

    place(RECT_A);
    expect(placeLog).toEqual([RECT_A]);

    // Two more rectangles arrive while the first is still in flight; only
    // the newest of them is sent once the first resolves.
    place(RECT_B);
    place(RECT_C);
    expect(placeLog).toEqual([RECT_A]);

    await resolveNext();
    expect(placeLog).toEqual([RECT_A, RECT_C]);

    await resolveNext();
    expect(placeLog).toEqual([RECT_A, RECT_C]);
  });

  it("keeps going after a placement fails, and sends the same rectangle again", async () => {
    browser.tabs = [tab(1, "https://example.com/")];
    browser.active = 1;
    show();

    place(RECT_A);
    place(RECT_B);
    const first = pending.shift();
    if (first?.kind !== "place") throw new Error("expected a placement");
    first.reject(new Error("no such webview"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(placeLog).toEqual([RECT_A, RECT_B]);

    await resolveNext();
    place(RECT_A);
    expect(placeLog).toEqual([RECT_A, RECT_B, RECT_A]);
  });

  it("skips a rectangle equal to the one already placed", async () => {
    browser.tabs = [tab(1, "https://example.com/")];
    browser.active = 1;
    show();

    place(RECT_A);
    await resolveNext();
    expect(placeLog).toEqual([RECT_A]);

    place({ ...RECT_A });
    expect(placeLog).toEqual([RECT_A]);
    expect(pending).toEqual([]);
  });

  it("hides the native view instead of placing it while there is no tab to show, or the browser is not showing", async () => {
    const shown = tab(1, "https://example.com/");
    const blank = tab(2, "about:blank");
    browser.tabs = [shown, blank];
    browser.active = 1;
    show();

    place(RECT_A);
    await resolveNext();
    expect(placeLog).toEqual([RECT_A]);
    expect(hideCount).toBe(0);

    // The active tab becomes a new tab: the view is hidden rather than
    // placed there.
    browser.active = 2;
    place(RECT_B);
    await resolveNext();
    expect(hideCount).toBe(1);
    expect(placeLog).toEqual([RECT_A]);

    // Already hidden: a second attempt does not hide again.
    place(RECT_B);
    expect(pending).toEqual([]);
    expect(hideCount).toBe(1);

    // Back on a real tab, showing again: a placement lands as usual.
    browser.active = 1;
    place(RECT_C);
    await resolveNext();
    expect(placeLog).toEqual([RECT_A, RECT_C]);

    // The viewer stops showing the browser at all: hidden again.
    hide();
    await resolveNext();
    expect(hideCount).toBe(2);

    // Still not showing: no further hide is sent.
    place(RECT_A);
    expect(pending).toEqual([]);
    expect(hideCount).toBe(2);
  });
});

describe("addressError", () => {
  it("is set by a rejected navigate and cleared by the next attempt", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;

    navigateError = "not an address";
    await navigate("bad address");
    expect(browser.addressError).toContain("not an address");

    navigateError = null;
    await navigate("https://b.example/");
    expect(browser.addressError).toBeNull();
    expect(navigated).toEqual([
      { id: 1, address: "bad address" },
      { id: 1, address: "https://b.example/" },
    ]);
  });

  it("is cleared when the active tab changes", async () => {
    browser.tabs = [tab(1, "https://a.example/"), tab(2, "https://b.example/")];
    browser.active = 1;

    navigateError = "not an address";
    await navigate("bad");
    expect(browser.addressError).not.toBeNull();

    nextSnapshot = { tabs: browser.tabs, active: 2 };
    await activate(2);
    expect(browser.addressError).toBeNull();
  });

  it("is set by a url open refuses", async () => {
    openError = "only http and https addresses open here";
    await open("javascript:alert(1)");
    expect(browser.addressError).toContain("only http and https");
    expect(browser.tabs).toEqual([]);
  });
});

describe("navigate", () => {
  it("opens a tab at the address when there is none open yet", async () => {
    browser.tabs = [];
    browser.active = null;
    openResult = { tabs: [tab(1, "https://example.com/")], active: 1 };

    await navigate("example.com");

    expect(opened).toEqual([{ url: "example.com", session: null }]);
    expect(navigated).toEqual([]);
    expect(browser.tabs.map((t) => t.id)).toEqual([1]);
    expect(browser.active).toBe(1);
  });
});

describe("snapshot events", () => {
  it("replace the tabs and active id", async () => {
    await initBrowser();
    expect(tabsHandler).not.toBeNull();

    tabsHandler!({ tabs: [tab(5, "https://x.example/")], active: 5 });
    expect(browser.tabs.map((t) => t.id)).toEqual([5]);
    expect(browser.active).toBe(5);

    tabsHandler!({ tabs: [], active: null });
    expect(browser.tabs).toEqual([]);
    expect(browser.active).toBeNull();
  });

  it("loads what is already open, once, when the store starts", async () => {
    tabsSnapshot = { tabs: [tab(9, "https://z.example/")], active: 9 };
    await initBrowser();
    expect(browser.active).toBe(9);

    // A second call neither subscribes again nor reloads.
    tabsSnapshot = { tabs: [], active: null };
    await initBrowser();
    expect(browser.active).toBe(9);
  });
});

describe("activeTab", () => {
  it("is the tab whose id matches active, or null", () => {
    browser.tabs = [tab(1, "https://a.example/"), tab(2, "https://b.example/")];
    browser.active = 2;
    expect(activeTab()?.id).toBe(2);

    browser.active = 99;
    expect(activeTab()).toBeNull();

    browser.active = null;
    expect(activeTab()).toBeNull();
  });
});

describe("tab lifecycle", () => {
  it("open, close and activate apply the snapshot the core returns", async () => {
    openResult = { tabs: [tab(1, "https://a.example/")], active: 1 };
    await open("a.example", "session-1");
    expect(opened).toEqual([{ url: "a.example", session: "session-1" }]);
    expect(browser.active).toBe(1);

    nextSnapshot = {
      tabs: [tab(1, "https://a.example/"), tab(2, "https://b.example/")],
      active: 2,
    };
    await close(3);
    expect(closed).toEqual([3]);
    expect(browser.tabs.map((t) => t.id)).toEqual([1, 2]);

    nextSnapshot = { tabs: browser.tabs, active: 1 };
    await activate(1);
    expect(activated).toEqual([1]);
    expect(browser.active).toBe(1);
  });
});

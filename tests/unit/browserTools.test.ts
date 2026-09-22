import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRequest, BrowserTab } from "$lib/core";

const answers: {
  id: string;
  cwd: string;
  content: string | null;
  error: string | null;
}[] = [];
const opened: { url: string | null; session: string | null }[] = [];
const activated: number[] = [];
const closed: number[] = [];
const navigated: { id: number; address: string }[] = [];
const stepped: { kind: string; id: number }[] = [];
const clicked: { id: number | null; ref: string }[] = [];
const typed: { id: number | null; ref: string; text: string; submit: boolean }[] = [];
const evaluated: { id: number | null; script: string }[] = [];

let openResult: unknown = { tabs: [], active: null };
let openError: string | null = null;
let navigateError: string | null = null;
let clickError: string | null = null;
let typeError: string | null = null;
let nextSnapshot: unknown = { tabs: [], active: null };
let snapshotText = "page text [ref=e1]";
let consoleEntries: { level: string; text: string; time: number; url: string }[] = [];
let screenshotPath = "/tmp/workbench-browser/1-fake.png";
let evalResult = "null";

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
    browserBack: async (id: number) => {
      stepped.push({ kind: "back", id });
    },
    browserForward: async (id: number) => {
      stepped.push({ kind: "forward", id });
    },
    browserReload: async (id: number) => {
      stepped.push({ kind: "reload", id });
    },
    browserHome: async () => {},
    browserPlace: async () => {},
    browserHide: async () => {},
    browserTabs: async () => ({ tabs: [], active: null }),
    onBrowserTabs: async () => () => {},
    browserSnapshot: async (id: number | null) => {
      if (id === 999) throw new Error("no such tab");
      return snapshotText;
    },
    browserClick: async (id: number | null, ref: string) => {
      clicked.push({ id, ref });
      if (clickError !== null) throw new Error(clickError);
    },
    browserType: async (id: number | null, ref: string, text: string, submit: boolean) => {
      typed.push({ id, ref, text, submit });
      if (typeError !== null) throw new Error(typeError);
    },
    browserConsole: async () => consoleEntries,
    browserScreenshot: async () => screenshotPath,
    browserEval: async (id: number | null, script: string) => {
      evaluated.push({ id, script });
      return evalResult;
    },
    browserAnswer: async (
      id: string,
      cwd: string,
      content: string | null,
      error: string | null,
    ) => {
      answers.push({ id, cwd, content, error });
    },
  }),
}));

import { browser, resetBrowser } from "$lib/browser.svelte";
import { handle, resetBrowserTools } from "$lib/browserTools.svelte";

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

let calls = 0;

function call(
  tool: BrowserRequest["tool"],
  args: Record<string, unknown> = {},
  extra: Partial<BrowserRequest> = {},
): BrowserRequest {
  return {
    id: `b${++calls}`,
    tool,
    arguments: args,
    cwd: "/home/ada/dev/demo",
    session: null,
    ...extra,
  };
}

const last = () => answers[answers.length - 1];

beforeEach(() => {
  resetBrowser();
  resetBrowserTools();
  answers.length = 0;
  opened.length = 0;
  activated.length = 0;
  closed.length = 0;
  navigated.length = 0;
  stepped.length = 0;
  clicked.length = 0;
  typed.length = 0;
  evaluated.length = 0;
  openResult = { tabs: [], active: null };
  openError = null;
  navigateError = null;
  clickError = null;
  typeError = null;
  nextSnapshot = { tabs: [], active: null };
  snapshotText = "page text [ref=e1]";
  consoleEntries = [];
  screenshotPath = "/tmp/workbench-browser/1-fake.png";
  evalResult = "null";
});

describe("browser_open", () => {
  it("opens the url, shows the browser, and answers with the tab", async () => {
    openResult = { tabs: [tab(1, "https://example.com/", { title: "Example" })], active: 1 };
    await handle(call("browser_open", { url: "https://example.com" }));
    expect(opened).toEqual([{ url: "https://example.com", session: null }]);
    expect(last().error).toBeNull();
    expect(last().content).toBe("Opened tab 1: https://example.com/, Example");
  });

  it("refuses without a url", async () => {
    await handle(call("browser_open", {}));
    expect(opened).toEqual([]);
    expect(last().error).toContain("needs a url");
  });

  it("reports a rejected address as the tool's error", async () => {
    openError = "only http and https addresses open here";
    await handle(call("browser_open", { url: "javascript:alert(1)" }));
    expect(last().error).toContain("only http and https");
  });
});

describe("browser_tabs", () => {
  it("says nothing is open", async () => {
    await handle(call("browser_tabs"));
    expect(last().content).toBe("No tabs are open.");
  });

  it("lists each tab with its state", async () => {
    browser.tabs = [
      tab(1, "https://a.example/", { title: "A" }),
      tab(2, "https://b.example/", { loading: true }),
    ];
    browser.active = 1;
    await handle(call("browser_tabs"));
    const text = last().content!;
    expect(text).toContain("1  https://a.example/  A  active");
    expect(text).toContain("2  https://b.example/  (no title)  loading");
  });
});

describe("browser_navigate", () => {
  it("refuses when no tab is open", async () => {
    await handle(call("browser_navigate", { url: "https://a.example/" }));
    expect(last().error).toBe("No tab is open.");
  });

  it("navigates the active tab by url", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    await handle(call("browser_navigate", { url: "https://b.example/" }));
    expect(navigated).toEqual([{ id: 1, address: "https://b.example/" }]);
    expect(last().error).toBeNull();
  });

  it("answers once the page has stopped loading, with where it landed", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    const answered = handle(call("browser_navigate", { url: "https://b.example/" }));
    browser.tabs = [{ ...tab(1, "https://b.example/"), loading: true }];
    await new Promise((resolve) => setTimeout(resolve, 300));
    browser.tabs = [{ ...tab(1, "https://b.example/"), title: "B" }];
    await answered;
    expect(last().content).toBe("Navigated tab 1: https://b.example/, B");
  });

  it("says so when the page did not load", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    const answered = handle(call("browser_navigate", { url: "localhost:9" }));
    browser.tabs = [
      { ...tab(1, "http://localhost:9/"), error: "localhost:9 is not answering" },
    ];
    await answered;
    expect(last().error).toBe(
      "Tab 1 did not load http://localhost:9/: localhost:9 is not answering.",
    );
  });

  it("steps a named tab by action", async () => {
    browser.tabs = [tab(1, "https://a.example/"), tab(2, "https://b.example/")];
    browser.active = 1;
    await handle(call("browser_navigate", { tab: 2, action: "reload" }));
    expect(stepped).toEqual([{ kind: "reload", id: 2 }]);
  });

  it("refuses a url and an action together, and neither", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    await handle(call("browser_navigate", { url: "https://b.example/", action: "back" }));
    expect(last().error).toContain("not both");
    await handle(call("browser_navigate", {}));
    expect(last().error).toContain("a url, or an action");
  });

  it("carries the address rule's own refusal back as the tool's error", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    navigateError = "not an address";
    await handle(call("browser_navigate", { url: "not an address" }));
    expect(last().error).toContain("not an address");
  });
});

describe("browser_snapshot", () => {
  it("refuses when no tab is open", async () => {
    await handle(call("browser_snapshot"));
    expect(last().error).toBe("No tab is open.");
  });

  it("answers with the page's text", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    await handle(call("browser_snapshot"));
    expect(last().content).toBe("page text [ref=e1]");
  });

  it("acts on a named tab rather than the active one", async () => {
    browser.tabs = [tab(1, "https://a.example/"), tab(999, "https://b.example/")];
    browser.active = 1;
    await handle(call("browser_snapshot", { tab: 999 }));
    expect(last().error).toContain("no such tab");
  });
});

describe("browser_click and browser_type", () => {
  beforeEach(() => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
  });

  it("clicks a ref and answers, and refuses a stale one", async () => {
    await handle(call("browser_click", { ref: "e1" }));
    expect(clicked).toEqual([{ id: 1, ref: "e1" }]);
    expect(last().content).toBe("Clicked e1 in tab 1.");

    clickError = "no such element; take a new snapshot";
    await handle(call("browser_click", { ref: "gone" }));
    expect(last().error).toContain("no such element; take a new snapshot");
  });

  it("refuses a click with no ref", async () => {
    await handle(call("browser_click", {}));
    expect(last().error).toContain("needs a ref");
  });

  it("types text, with submit passed through", async () => {
    await handle(call("browser_type", { ref: "e1", text: "hello", submit: true }));
    expect(typed).toEqual([{ id: 1, ref: "e1", text: "hello", submit: true }]);
    expect(last().content).toBe("Typed into e1 in tab 1.");
  });

  it("refuses typing with no text", async () => {
    await handle(call("browser_type", { ref: "e1" }));
    expect(last().error).toContain("needs the text");
  });
});

describe("browser_console", () => {
  it("says the console is empty", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    await handle(call("browser_console"));
    expect(last().content).toBe("The console is empty.");
  });

  it("lists the entries by level", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    consoleEntries = [{ level: "error", text: "boom", time: 0, url: "https://a.example/" }];
    await handle(call("browser_console"));
    expect(last().content).toBe("[error] boom");
  });
});

describe("browser_screenshot", () => {
  it("shows the browser, activates the named tab, and answers with the path", async () => {
    browser.tabs = [tab(1, "https://a.example/"), tab(2, "https://b.example/")];
    browser.active = 1;
    nextSnapshot = { tabs: browser.tabs, active: 2 };
    screenshotPath = "/tmp/workbench-browser/2-fake.png";
    await handle(call("browser_screenshot", { tab: 2 }));
    expect(activated).toEqual([2]);
    expect(last().content).toBe("/tmp/workbench-browser/2-fake.png");
  });
});

describe("browser_eval", () => {
  it("refuses without a script", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    await handle(call("browser_eval", {}));
    expect(last().error).toContain("needs its body");
  });

  it("runs the script and answers with its JSON result", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    evalResult = '{"ok":true}';
    await handle(call("browser_eval", { script: "return 1" }));
    expect(evaluated).toEqual([{ id: 1, script: "return 1" }]);
    expect(last().content).toBe('{"ok":true}');
  });
});

describe("browser_close", () => {
  it("refuses without a tab", async () => {
    await handle(call("browser_close", {}));
    expect(last().error).toContain("needs a tab");
  });

  it("refuses a tab that is not open", async () => {
    await handle(call("browser_close", { tab: 9 }));
    expect(last().error).toBe("The workbench has no tab 9.");
  });

  it("closes a known tab", async () => {
    browser.tabs = [tab(1, "https://a.example/")];
    browser.active = 1;
    await handle(call("browser_close", { tab: 1 }));
    expect(closed).toEqual([1]);
    expect(last().content).toBe("Closed tab 1.");
  });
});

describe("unknown tools and duplicate calls", () => {
  it("refuses a tool it does not have", async () => {
    await handle({
      id: "bx",
      tool: "browser_delete" as BrowserRequest["tool"],
      arguments: {},
      cwd: "/home/ada/dev/demo",
      session: null,
    });
    expect(last().error).toContain("has no browser_delete tool");
  });

  it("answers a call once even when it is delivered twice", async () => {
    const request = call("browser_tabs");
    await handle(request);
    await handle(request);
    expect(answers).toHaveLength(1);
  });
});

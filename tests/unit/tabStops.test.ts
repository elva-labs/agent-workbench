import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followTabStops, tabWithin } from "$lib/tabStops";

/** The rule's changes arrive with the observer, a microtask later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const index = (id: string) => document.getElementById(id)?.getAttribute("tabindex") ?? null;

function key(target: Element, name: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe("the tab stop rule", () => {
  let stop: () => void;

  beforeEach(() => {
    document.body.innerHTML = "";
    stop = followTabStops();
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = "";
  });

  it("makes every control a stop as it arrives, and leaves text fields as they are", async () => {
    document.body.innerHTML = `
      <button id="b">Go</button>
      <a id="a" href="#">Link</a>
      <a id="plain">No link</a>
      <select id="s"><option>one</option></select>
      <input id="c" type="checkbox" />
      <input id="t" type="text" />
      <textarea id="x"></textarea>`;
    await settle();
    expect(index("b")).toBe("0");
    expect(index("a")).toBe("0");
    expect(index("plain")).toBeNull();
    expect(index("s")).toBe("0");
    expect(index("c")).toBe("0");
    expect(index("t")).toBeNull();
    expect(index("x")).toBeNull();
  });

  it("keeps a tab index a control sets for itself, and gives one back when it is taken away", async () => {
    document.body.innerHTML = `<button id="own" tabindex="-1">Own</button><button id="b">Go</button>`;
    await settle();
    expect(index("own")).toBe("-1");
    document.getElementById("own")!.removeAttribute("tabindex");
    await settle();
    expect(index("own")).toBe("0");
  });

  it("touches nothing inside a terminal", async () => {
    document.body.innerHTML = `<div class="xterm"><a id="inside" href="#">x</a></div>`;
    await settle();
    expect(index("inside")).toBeNull();
  });

  it("makes a radio group one stop, on the checked item, and follows the check", async () => {
    document.body.innerHTML = `
      <div role="radiogroup">
        <button id="one" role="radio" aria-checked="false">One</button>
        <button id="two" role="radio" aria-checked="true">Two</button>
        <button id="three" role="radio" aria-checked="false">Three</button>
        <button id="extra">×</button>
      </div>`;
    await settle();
    expect([index("one"), index("two"), index("three"), index("extra")]).toEqual(["-1", "0", "-1", "-1"]);
    document.getElementById("two")!.setAttribute("aria-checked", "false");
    document.getElementById("three")!.setAttribute("aria-checked", "true");
    await settle();
    expect([index("one"), index("two"), index("three")]).toEqual(["-1", "-1", "0"]);
  });

  it("stops on the first item of a list with nothing chosen, and on one added later", async () => {
    document.body.innerHTML = `<div role="listbox" id="list"><button id="one" role="option">One</button></div>`;
    await settle();
    expect(index("one")).toBe("0");
    const two = document.createElement("button");
    two.id = "two";
    two.setAttribute("role", "option");
    two.setAttribute("aria-selected", "true");
    document.getElementById("list")!.append(two);
    await settle();
    expect([index("one"), index("two")]).toEqual(["-1", "0"]);
  });

  it("leaves a list whose items set their own tab indexes", async () => {
    document.body.innerHTML = `
      <div role="listbox">
        <button id="one" role="option" tabindex="-1">One</button>
        <button id="two" role="option" tabindex="-1" aria-selected="true">Two</button>
      </div>`;
    await settle();
    expect([index("one"), index("two")]).toEqual(["-1", "-1"]);
  });

  it("gives the items of a menu or a tree no stop of their own", async () => {
    document.body.innerHTML = `
      <div role="menu"><button id="item" role="menuitem">Item</button></div>
      <div role="tree" tabindex="0"><button id="row">Row</button></div>`;
    await settle();
    expect(index("item")).toBe("-1");
    expect(index("row")).toBe("-1");
  });

  it("walks a list with the arrows, Home and End, past a disabled item, without picking", async () => {
    document.body.innerHTML = `
      <div role="radiogroup">
        <button id="one" role="radio" aria-checked="true">One</button>
        <button id="two" role="radio" aria-checked="false" disabled>Two</button>
        <button id="three" role="radio" aria-checked="false">Three</button>
      </div>`;
    await settle();
    const one = document.getElementById("one")!;
    one.focus();
    expect(key(one, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("three");
    expect(index("three")).toBe("0");
    expect(index("one")).toBe("-1");
    expect(document.getElementById("three")!.getAttribute("aria-checked")).toBe("false");
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement?.id).toBe("one");
    key(document.activeElement!, "End");
    expect(document.activeElement?.id).toBe("three");
    key(document.activeElement!, "Home");
    expect(document.activeElement?.id).toBe("one");
  });

  it("presses an item that is not a button on Enter or Space", async () => {
    document.body.innerHTML = `<div role="tablist"><div id="tab" role="tab">A</div></div>`;
    await settle();
    let pressed = 0;
    const tab = document.getElementById("tab")!;
    tab.addEventListener("click", () => (pressed += 1));
    tab.focus();
    key(tab, "Enter");
    key(tab, " ");
    expect(pressed).toBe(2);
  });

  it("moves a Tab the browser left where it was, and nothing that moved since", async () => {
    document.body.innerHTML = `<button id="one">One</button><button id="two">Two</button>`;
    await settle();
    // jsdom lays nothing out, so every stop is taken as drawn.
    for (const button of document.querySelectorAll("button"))
      button.getClientRects = () => [{}] as unknown as DOMRectList;
    const one = document.getElementById("one")!;
    const two = document.getElementById("two")!;
    one.focus();
    // jsdom moves nothing on Tab, as WebKit does after a click in a list.
    key(one, "Tab");
    await settle();
    expect(document.activeElement).toBe(two);
    // A Tab whose move a later key undid is not moved again.
    key(two, "Tab");
    one.focus();
    two.focus();
    await settle();
    expect(document.activeElement).toBe(two);
    key(two, "Tab", { shiftKey: true });
    key(two, "ArrowDown");
    await settle();
    expect(document.activeElement).toBe(two);
  });

  it("stands down for a key the list's owner handled", async () => {
    document.body.innerHTML = `
      <div role="radiogroup" id="group">
        <button id="one" role="radio" aria-checked="true">One</button>
        <button id="two" role="radio" aria-checked="false">Two</button>
      </div>`;
    await settle();
    document.getElementById("group")!.addEventListener("keydown", (e) => e.preventDefault());
    const one = document.getElementById("one")!;
    one.focus();
    key(one, "ArrowRight");
    expect(document.activeElement?.id).toBe("one");
  });
});

describe("Tab within a part that holds the keyboard", () => {
  it("goes round the part's stops", () => {
    document.body.innerHTML = `<div id="strip"><button id="one">One</button><button id="two">Two</button></div>`;
    const strip = document.getElementById("strip")!;
    // jsdom lays nothing out, so every stop is taken as drawn.
    for (const button of strip.querySelectorAll("button"))
      button.getClientRects = () => [{}] as unknown as DOMRectList;
    const two = document.getElementById("two")!;
    two.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    tabWithin(forward, strip);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("one");
    tabWithin(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }), strip);
    expect(document.activeElement?.id).toBe("two");
    document.body.innerHTML = "";
  });
});

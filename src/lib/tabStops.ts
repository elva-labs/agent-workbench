/**
 * Where Tab goes, the same in WebKit as in any other browser.
 *
 * WebKit, the app's webview on macOS, passes over a button, a link, a
 * select or a check box on Tab unless the system's full keyboard access is
 * on, or the control carries a tab index of its own. So every control the
 * page holds is given one as it arrives, by one rule for the whole window:
 *
 * - A control is a stop of its own, in reading order.
 * - A list is one stop. A radio group, a tab list or a listbox stops on its
 *   checked or selected item, or its first; the arrow keys walk its items,
 *   Home and End jump, and Enter or Space presses the item, as a click
 *   does. The items of a menu, a tree or a grid are no stops of their own:
 *   what owns the list walks them.
 * - A control or a list that sets its own tab indexes keeps them, as a
 *   list walked from a field does by giving its items -1.
 * - Nothing inside a terminal is touched.
 *
 * While a dialog or the palette is up, Tab and Shift+Tab go round its own
 * stops and never reach what is under it, and so they do in a question
 * put in a strip, which holds the keyboard while it is up.
 */

/** The controls WebKit passes over unless they carry a tab index. Text
    fields are always stops, so they are left as they are. */
const CONTROL = [
  "button",
  "a[href]",
  "area[href]",
  "summary",
  "select",
  ...["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "image"].map(
    (type) => `input[type="${type}"]`,
  ),
].join(", ");

/** Lists this rule keeps to one stop and walks. */
const ROVING = '[role="radiogroup"], [role="tablist"], [role="listbox"]';
/** Their items. */
const ITEM = '[role="radio"], [role="tab"], [role="option"]';
/** Lists whose owner walks them. */
const WALKED = ["menu", "menubar", "tree", "treegrid", "grid"]
  .map((role) => `[role="${role}"]`)
  .join(", ");
const LIST = `${ROVING}, ${WALKED}`;

const TERMINAL = ".xterm";

/** What Tab can land on in a dialog, before the ones it cannot are left out. */
const FOCUSABLE =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

/** The tab index this rule gave each element, so one a component sets is
    told apart from ours. */
const given = new WeakMap<Element, string>();

function give(element: HTMLElement, index: string) {
  given.set(element, index);
  if (element.getAttribute("tabindex") !== index) element.setAttribute("tabindex", index);
}

/** Whether the element's tab index is its own rather than this rule's. */
function ownIndex(element: Element): boolean {
  const index = element.getAttribute("tabindex");
  return index !== null && given.get(element) !== index;
}

function rovingGroupOf(element: Element): HTMLElement | null {
  const list = element.closest<HTMLElement>(LIST);
  return list !== null && list.matches(ROVING) ? list : null;
}

function itemsOf(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(ITEM)].filter((item) => item.closest(LIST) === group);
}

function enabled(item: HTMLElement): boolean {
  return !(item as HTMLButtonElement).disabled && item.getAttribute("aria-disabled") !== "true";
}

function chosen(item: HTMLElement): boolean {
  return item.getAttribute("aria-checked") === "true" || item.getAttribute("aria-selected") === "true";
}

/** Gives a list the rule walks its one stop: the item with the keyboard
    while it has it, else the chosen one, else the first. */
function rove(group: HTMLElement) {
  const items = itemsOf(group);
  if (items.some(ownIndex)) return;
  const active = document.activeElement;
  const stop =
    items.find((item) => item === active) ??
    items.find((item) => chosen(item) && enabled(item)) ??
    items.find(enabled) ??
    null;
  for (const item of items) give(item, item === stop ? "0" : "-1");
}

/** Gives a control with no tab index of its own the one the rule says. */
function mark(element: HTMLElement, groups: Set<HTMLElement>) {
  if (element.hasAttribute("tabindex") || element.closest(TERMINAL) !== null) return;
  const list = element.closest<HTMLElement>(LIST);
  if (list === null) {
    give(element, "0");
    return;
  }
  if (list.matches(ROVING)) {
    groups.add(list);
    if (element.matches(ITEM)) return;
  }
  give(element, "-1");
}

function scan(root: Element, groups: Set<HTMLElement>) {
  if (!(root instanceof HTMLElement)) return;
  if (root.matches(CONTROL) || root.matches(ITEM)) mark(root, groups);
  for (const element of root.querySelectorAll<HTMLElement>(`${CONTROL}, ${ITEM}`)) mark(element, groups);
  if (root.matches(ROVING)) groups.add(root);
  for (const group of root.querySelectorAll<HTMLElement>(ROVING)) groups.add(group);
  const around = root.parentElement === null ? null : rovingGroupOf(root.parentElement);
  if (around !== null) groups.add(around);
}

function onMutations(records: MutationRecord[]) {
  const groups = new Set<HTMLElement>();
  for (const record of records) {
    const target = record.target;
    if (!(target instanceof HTMLElement)) continue;
    if (record.type === "childList") {
      for (const node of record.addedNodes) if (node instanceof Element) scan(node, groups);
      if (record.removedNodes.length > 0) {
        const group = rovingGroupOf(target);
        if (group !== null) groups.add(group);
      }
      continue;
    }
    if (record.attributeName === "tabindex") {
      // Taken away by a component that set it: the rule gives it again.
      if (!target.hasAttribute("tabindex")) {
        given.delete(target);
        scan(target, groups);
      }
      continue;
    }
    if (record.attributeName === "role") scan(target, groups);
    const group = rovingGroupOf(target);
    if (group !== null) groups.add(group);
  }
  for (const group of groups) if (group.isConnected) rove(group);
}

/** The next enabled item from `from`, round the list. */
function step(items: HTMLElement[], from: number, by: 1 | -1): HTMLElement | null {
  for (let turn = 1; turn <= items.length; turn++) {
    const item = items[(from + by * turn + items.length * turn) % items.length];
    if (enabled(item)) return item;
  }
  return null;
}

function walk(e: KeyboardEvent, item: HTMLElement, group: HTMLElement) {
  const items = itemsOf(group);
  if (items.some(ownIndex)) return;
  const at = items.indexOf(item);
  let next: HTMLElement | null = null;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = step(items, at, 1);
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = step(items, at, -1);
      break;
    case "Home":
      next = items.find(enabled) ?? null;
      break;
    case "End":
      next = [...items].reverse().find(enabled) ?? null;
      break;
    case "Enter":
    case " ":
      // A button presses itself on either; an item that is not one is
      // pressed here.
      if (item instanceof HTMLButtonElement || item instanceof HTMLInputElement) return;
      e.preventDefault();
      item.click();
      return;
    default:
      return;
  }
  e.preventDefault();
  if (next === null) return;
  give(next, "0");
  next.focus();
}

function visible(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function")
    return element.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

/** The stops of a dialog, in the order Tab reaches them. */
export function stopsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !(element as HTMLButtonElement).disabled &&
      element.closest("[inert]") === null &&
      visible(element),
  );
}

/** The stop Tab goes to from `from`, or Shift+Tab with `back`, round the
    ends. */
function nextStop(stops: HTMLElement[], from: Element, back: boolean): HTMLElement {
  const follows = (stop: HTMLElement) => (from.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  if (back) return stops.filter((stop) => stop !== from && !follows(stop)).at(-1) ?? stops[stops.length - 1];
  return stops.find((stop) => stop !== from && follows(stop)) ?? stops[0];
}

/** Tab and Shift+Tab: kept inside the dialog or palette that is up, past
    its last stop round to its first and back. */
function onTab(e: KeyboardEvent) {
  const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')];
  const active = document.activeElement;
  const modal = modals.findLast((candidate) => candidate.contains(active)) ?? modals.at(-1) ?? null;
  if (modal !== null) {
    const stops = stopsIn(modal);
    e.preventDefault();
    if (stops.length === 0) return;
    if (active === null || !modal.contains(active)) (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    else nextStop(stops, active, e.shiftKey).focus();
    return;
  }
  // WebKit starts Tab from where the last click landed, so after a click
  // on a row of a list that already has the keyboard, Shift+Tab finds the
  // list itself and the keyboard stays. A key that moved nothing is moved
  // here, once the browser has had its turn.
  const before = active;
  setTimeout(() => {
    if (e.defaultPrevented || document.activeElement !== before) return;
    if (!(before instanceof HTMLElement) || before === document.body) return;
    const stops = stopsIn(document.body);
    if (stops.length > 1) nextStop(stops, before, e.shiftKey).focus();
  });
}

/** Keeps Tab and Shift+Tab inside `root`, round its ends, for a part that
    holds the keyboard while it is up without being a dialog, such as a
    question put in a strip. */
export function tabWithin(e: KeyboardEvent, root: HTMLElement) {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  const stops = stopsIn(root);
  if (stops.length === 0) return;
  const active = document.activeElement;
  if (active === null || !root.contains(active)) (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
  else nextStop(stops, active, e.shiftKey).focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "Tab") {
    onTab(e);
    return;
  }
  const item = e.target instanceof HTMLElement ? e.target : null;
  if (item === null || !item.matches(ITEM)) return;
  const group = rovingGroupOf(item);
  if (group !== null) walk(e, item, group);
}

function onFocusIn(e: FocusEvent) {
  const item = e.target instanceof HTMLElement ? e.target : null;
  if (item === null || !item.matches(ITEM)) return;
  const group = rovingGroupOf(item);
  if (group !== null) rove(group);
}

function onFocusOut(e: FocusEvent) {
  const item = e.target instanceof HTMLElement ? e.target : null;
  if (item === null || !item.matches(ITEM)) return;
  const group = rovingGroupOf(item);
  if (group === null || (e.relatedTarget instanceof Node && group.contains(e.relatedTarget))) return;
  queueMicrotask(() => {
    if (group.isConnected) rove(group);
  });
}

/** Applies the rule to the document from now on. Returns what stops it. */
export function followTabStops(root: HTMLElement = document.body): () => void {
  const groups = new Set<HTMLElement>();
  scan(root, groups);
  for (const group of groups) rove(group);
  const observer = new MutationObserver(onMutations);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["tabindex", "role", "aria-checked", "aria-selected", "disabled", "aria-disabled"],
  });
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    observer.disconnect();
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
}

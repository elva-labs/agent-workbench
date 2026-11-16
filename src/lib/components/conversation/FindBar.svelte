<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Conversation, Message } from "$lib/conversation.svelte";
  import { Finder, clearMatches, findAsked, paintMatches } from "$lib/find.svelte";
  import { giveBack, lend } from "$lib/folds";
  import { spoken } from "$lib/instructions";
  import { actionOf, chordFromEvent } from "$lib/keys.svelte";
  import { unsent } from "$lib/mention";
  import { mentionsOf } from "$lib/mentioned.svelte";
  import { isMac } from "$lib/platform";
  import { senderOf } from "$lib/senders.svelte";
  import Icon from "./Icon.svelte";
  import type Thread from "./Thread.svelte";

  /**
   * Find in the conversation: a bar over the top of the thread that looks
   * for words in all of it, drawn or not, folded work included. It says
   * how many matches there are and which is the current one; every match
   * drawn is tinted and the current one filled. Enter and Shift+Enter, Cmd+G
   * and Shift+Cmd+G (Ctrl off macOS), and the two arrows step through them,
   * wrapping at the ends, and the thread brings each into the middle of the
   * view, opening the folds that hold it until find moves on. Escape or the
   * close button puts the bar away, closes what it opened, and gives the
   * keyboard back where it was.
   */
  interface Props {
    conversation: Conversation;
    thread: Thread | null;
    /** The folder paths in the thread are shown from. */
    root: string | null;
    /** The session is on screen in the pane. */
    active: boolean;
    /** The view the bar stands in, which the keyboard goes back into. */
    host: HTMLElement | null;
    /** The bar is open. */
    open?: boolean;
  }

  let { conversation, thread, root, active, host, open = $bindable(false) }: Props = $props();
  const id = $props.id();

  /** A message's words as its bubble shows them. */
  function words(message: Message): string {
    const said = spoken(message.text, senderOf(message) === null).text;
    return unsent(said, mentionsOf(message.id)).draft;
  }

  const finder = new Finder(
    () => conversation,
    () => ({ root, words }),
  );

  let field = $state<HTMLInputElement | null>(null);
  let bar = $state<HTMLDivElement | null>(null);
  /** Where the keyboard was before it came to the bar. */
  let from: HTMLElement | null = null;
  const mac = isMac();

  let label = $derived.by(() => {
    if (finder.query === "" || finder.total === null) return "";
    if (finder.total === 0) return "No matches";
    return `${finder.current + 1} of ${finder.total}`;
  });

  /** Opens the bar with the keyboard in its field, its words selected, and
      looks for them again. */
  export function show() {
    const owner = document.activeElement;
    if (owner instanceof HTMLElement && owner !== document.body && !(bar?.contains(owner) ?? false)) from = owner;
    const was = open;
    open = true;
    void tick().then(() => {
      field?.focus();
      field?.select();
    });
    if (!was && finder.query !== "") seek();
  }

  /** Puts the bar away, closing the folds it opened, and gives the
      keyboard back where it was when it had it. */
  export function hide() {
    if (!open) return;
    const had = bar?.contains(document.activeElement) ?? false;
    open = false;
    finder.cancel();
    wanted = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    clearMatches();
    giveBack(conversation.opened);
    if (!had && document.activeElement !== document.body) return;
    const back =
      from !== null && from.isConnected && host?.contains(from)
        ? from
        : host?.querySelector<HTMLElement>("[data-testid='composer-input']");
    back?.focus({ preventScroll: true });
  }

  /** Where a search for new words starts while it is on its way: the
      thing the match before them is in, or the top of the view. */
  let wanted: { key: string | null; entry: string | null } | null = null;

  /** Looks for new words, starting from the match before them, or from
      the top of the view, and goes to the first it finds. */
  function seek() {
    const was = finder.hit();
    wanted = { key: was?.key ?? null, entry: thread?.topRow() ?? null };
    void count();
  }

  /** Counts the matches: for new words, going to the first; otherwise
      marking them again, the current one where it was. */
  async function count() {
    const start = wanted;
    if (!(await finder.search(start))) return;
    if (start === null) {
      paintSoon();
      return;
    }
    wanted = null;
    await go();
  }

  /** Brings the current match into view: the folds that hold it open, the
      ones opened for the match before closed, and the turn it is in drawn. */
  async function go() {
    const hit = finder.hit();
    let moved = giveBack(conversation.opened, hit?.held.folds ?? []);
    if (hit === null) {
      paint();
      return;
    }
    for (const fold of hit.held.folds) moved = lend(conversation.opened, fold) || moved;
    await tick();
    // The thread takes in what opened and closed before the match is
    // measured.
    if (moved) await frames(2);
    if (!open || finder.hit()?.key !== hit.key) return;
    let range = paint();
    if (range === null && hit.held.entry !== null && thread !== null) {
      await thread.reveal(hit.held.entry);
      range = paint();
    }
    if (range !== null) await thread?.center(() => (finder.hit()?.key === hit.key ? paint() : null));
  }

  const frames = (count: number) =>
    new Promise<void>((resolve) => {
      const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
      next(count);
    });

  function step(by: 1 | -1) {
    if (!finder.total) return;
    finder.step(by);
    void go();
  }

  function paint(): Range | null {
    const scroller = host?.querySelector("[data-testid='thread']") ?? null;
    if (!open || !active || scroller === null || finder.query === "") {
      clearMatches();
      return null;
    }
    const hit = finder.hit();
    return paintMatches(scroller, finder.query, new Set(finder.found.map((one) => one.held.key)), hit);
  }

  let frame: number | null = null;
  function paintSoon() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  }

  // What the thread draws changes as the view moves, folds open and words
  // come: the matches drawn are marked again a frame later.
  $effect(() => {
    if (!open || !active || host === null) return;
    const scroller = host.querySelector("[data-testid='thread']");
    if (scroller === null) return;
    const watch = new MutationObserver(paintSoon);
    watch.observe(scroller, { childList: true, subtree: true, characterData: true });
    untrack(paintSoon);
    return () => {
      watch.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
  });

  // Off screen, the session leaves the marks to the one on screen.
  $effect(() => {
    if (!active) untrack(() => clearMatches());
  });

  let timer: ReturnType<typeof setTimeout> | null = null;

  // The conversation changed: the matches are counted again, a little
  // after the change, the current one staying on what holds it.
  $effect(() => {
    void conversation.revision;
    if (!open) return;
    untrack(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (finder.query !== "") void count();
      }, 150);
    });
  });

  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
    if (active) clearMatches();
    giveBack(conversation.opened);
  });

  // The chord asks the session on screen to find.
  let asked = findAsked.count;
  $effect(() => {
    const count = findAsked.count;
    untrack(() => {
      if (count === asked) return;
      asked = count;
      if (active) show();
    });
  });

  /** A screen reader hears the count once it settles, once for each
      change. */
  let heard = $state("");
  $effect(() => {
    const now = open ? label : "";
    const wait = setTimeout(() => (heard = now), 250);
    return () => clearTimeout(wait);
  });

  /** Cmd+G, Ctrl+G off macOS, which steps as Enter does, while no action
      holds the chord. */
  function stepKey(e: KeyboardEvent): boolean {
    if (e.key.toLowerCase() !== "g" || e.altKey) return false;
    if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
    const chord = chordFromEvent(e, mac);
    return chord !== null && actionOf(chord) === null;
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (stepKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      step(e.shiftKey ? -1 : 1);
    }
  }

  /** Cmd+G steps from anywhere in the view while the bar is open. */
  function onWindowKey(e: KeyboardEvent) {
    if (!open || !active || e.defaultPrevented || e.isComposing || !stepKey(e)) return;
    if (!(host?.contains(document.activeElement) ?? false)) return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }

  function oninput(e: Event) {
    finder.query = (e.currentTarget as HTMLInputElement).value;
    seek();
  }

  const KEYS = mac
    ? { next: "↩", previous: "⇧↩", close: "esc" }
    : { next: "Enter", previous: "Shift+Enter", close: "Esc" };
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
  <div class="bar" role="search" aria-label="Find in the conversation" bind:this={bar} data-testid="find-bar">
    <label class="field">
      <span class="glyph"><Icon name="search" size={13} /></span>
      <input
        bind:this={field}
        type="text"
        value={finder.query}
        {oninput}
        {onkeydown}
        placeholder="Find"
        aria-label="Find in the conversation"
        aria-describedby="{id}-count"
        spellcheck="false"
        autocomplete="off"
        data-testid="find-input"
      />
    </label>
    <span
      class="count"
      class:none={finder.total === 0 && finder.query !== ""}
      id="{id}-count"
      data-testid="find-count">{label}</span
    >
    <span class="rule" aria-hidden="true"></span>
    <button
      class="step"
      disabled={!finder.total}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => step(-1)}
      aria-label="Previous match"
      title="Previous match ({KEYS.previous})"
      data-testid="find-previous"><Icon name="chev-up" size={14} /></button
    >
    <button
      class="step"
      disabled={!finder.total}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => step(1)}
      aria-label="Next match"
      title="Next match ({KEYS.next})"
      data-testid="find-next"><Icon name="down" size={14} /></button
    >
    <button
      class="step"
      onmousedown={(e) => e.preventDefault()}
      onclick={hide}
      aria-label="Close find"
      title="Close ({KEYS.close})"
      data-testid="find-close"><Icon name="x" size={13} /></button
    >
    <span class="heard" role="status" data-testid="find-heard">{heard}</span>
  </div>
{/if}

<style>
  .bar {
    position: absolute;
    top: 8px;
    right: 16px;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: calc(100% - 32px);
    padding: 4px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 8px 24px color-mix(in srgb, black 18%, transparent);
    font-size: var(--conv-small);
  }

  .field {
    flex: 0 1 190px;
    min-width: 80px;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    border-radius: var(--radius);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--rule);
    color: var(--ink);
    cursor: text;
  }

  .field:focus-within {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .glyph {
    flex: none;
    color: var(--ink-3);
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    outline: none;
    background: none;
    font: inherit;
    color: inherit;
  }

  input::placeholder {
    color: var(--ink-3);
  }

  .count {
    flex: none;
    min-width: 64px;
    padding: 0 8px;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    text-align: center;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .count.none {
    color: var(--del);
  }

  .rule {
    flex: none;
    width: 1px;
    height: 16px;
    margin: 0 3px;
    background: var(--rule);
  }

  .step {
    flex: none;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }

  .step:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  .step:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Heard, not seen. */
  .heard {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @container conversation (max-width: 520px) {
    .bar {
      right: 14px;
      max-width: calc(100% - 28px);
    }
  }

  /* Every match drawn is tinted, and the current one filled. */
  :global(::highlight(find-hit)) {
    background-color: color-mix(in srgb, var(--accent) 26%, transparent);
  }

  :global(::highlight(find-current)) {
    background-color: var(--accent);
    color: var(--surface);
  }
</style>

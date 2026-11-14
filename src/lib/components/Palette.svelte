<script lang="ts">
  import { tick, untrack } from "svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import type { Action } from "$lib/keymap";
  import { isMac } from "$lib/platform";
  import {
    ALONE,
    chipOf,
    closePalette,
    palette,
    paletteItems,
    pickable,
    pickItem,
    setQuery,
    startingId,
    stepBack,
    stepsLeft,
    WORKFLOWS,
    type PaletteItem,
  } from "$lib/palette.svelte";
  import { isLive } from "$lib/sessions.svelte";

  /**
   * The palette, over the workbench like the sessions to resume: a field
   * with the keyboard in it and a list under it. Enter or a click on an
   * entry does it, Escape puts the palette away.
   */

  interface Props {
    /** Does what an action's chord does. */
    perform: (action: Action) => void;
  }

  let { perform }: Props = $props();

  let dialog: HTMLDivElement;
  let field = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  let chosen = $state<string | null>(null);

  // The keyboard is taken on the way in, and again when a list is opened
  // while this one is still fading out. Closing hands it back.
  $effect(() => {
    palette.opened;
    field?.focus();
  });

  // A palette fading out has no keyboard: it went to the pane that had it.
  $effect(() => {
    if (!palette.open && dialog.contains(document.activeElement)) field?.blur();
  });

  let items = $derived(paletteItems());

  // The cursor follows the item chosen, wherever the list moves it. When the
  // item chosen is gone it sits on the first item that does something.
  const cursor = $derived.by(() => {
    const at = items.findIndex((item) => item.id === chosen);
    return at >= 0 ? at : Math.max(0, items.findIndex(pickable));
  });

  // A new query, a new step, and the opening one, choose the entry the
  // step starts on, else the first that does something, so the list
  // changing under it does not move the cursor.
  $effect(() => {
    palette.query;
    palette.mode;
    palette.steps;
    chosen = untrack(() => {
      const starting = startingId();
      return items.find((item) => item.id === starting)?.id ?? items.find(pickable)?.id ?? null;
    });
  });

  /** The cursor moves to the next item in a direction that does something. */
  function step(direction: 1 | -1) {
    for (let at = cursor + direction; at >= 0 && at < items.length; at += direction) {
      if (pickable(items[at])) {
        chosen = items[at].id;
        return;
      }
    }
  }

  /** The id an item's option carries, which follows the item and not its
      place in the list. */
  const optionId = (item: PaletteItem) =>
    `palette-opt-${item.id.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

  /** The list as runs of rows under one heading, each with the place its
      first row holds in the list. A new session's step is one list, which
      its field already names, so it has no heading, except how it runs when
      it offers workflows as well as agents. */
  const headed = $derived(
    palette.mode !== "new" ||
      (items.some((item) => item.group === WORKFLOWS) && items.some((item) => item.group === ALONE)),
  );
  const sections = $derived.by(() => {
    const runs: { group: string | null; start: number; rows: PaletteItem[] }[] = [];
    items.forEach((item, index) => {
      const group = headed ? item.group : null;
      const last = runs[runs.length - 1];
      if (last !== undefined && last.group === group) last.rows.push(item);
      else runs.push({ group, start: index, rows: [item] });
    });
    return runs;
  });

  // The cursor stays in view.
  $effect(() => {
    const at = cursor;
    tick().then(() => {
      list?.querySelectorAll<HTMLElement>("[role='option']")[at]?.scrollIntoView?.({ block: "nearest" });
    });
  });

  /** Puts the palette away, then does what the item does, so where the
      item puts the keyboard is where it stays. */
  async function run(item: PaletteItem | undefined, alone = false) {
    if (item === undefined) return;
    const outcome = pickItem(item, alone);
    if (outcome.type === "stay") return;
    closePalette();
    await tick();
    if (outcome.type === "close") outcome.then();
    else perform(outcome.action);
  }

  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    setQuery(e.currentTarget.value);
    // A `>` leaves the field empty with the query unchanged, so the text
    // the field shows is put right by hand.
    e.currentTarget.value = palette.query;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        closePalette();
        return;
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Enter":
        void run(items[cursor], isMac() ? e.metaKey : e.ctrlKey);
        break;
      case "Backspace":
        // An empty field steps back through a new session's questions, one
        // step to a press, however long the key is held.
        if (palette.mode !== "new" || palette.query !== "") return;
        if (e.repeat) break;
        stepBack();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !dialog.contains(e.target as Node)) closePalette();
  }

  const asking = $derived(stepsLeft(palette.steps)[0] ?? null);
  const placeholder = $derived(
    palette.mode === "goto"
      ? "Go to a session or project"
      : palette.mode === "commands"
        ? "Run a command"
        : asking === "project"
          ? "Which project"
          : asking === "account"
            ? "Under which account"
            : "How should it run",
  );
  const heading = $derived(
    palette.mode === "goto" ? "Sessions and projects" : palette.mode === "commands" ? "Commands" : "New session",
  );
  const nothingOpen = $derived(palette.mode === "goto" && palette.query.trim() === "");
  // What go to can do is what its list holds: sessions and projects to go to
  // and start in, the one row that opens a project when nothing is open, or
  // nothing.
  const goable = $derived(items.some((item) => item.kind === "session" || item.kind === "project"));
  const modifier = isMac() ? "⌘" : "Ctrl+";
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="scrim"
  class:leaving={!palette.open}
  onclick={closePalette}
  use:coversBrowser
  data-testid="palette-scrim"
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal={palette.open ? "true" : undefined}
    aria-label="Palette"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="palette"
    data-mode={palette.mode}
  >
    <div class="entry">
      {#if palette.mode === "commands"}
        <span class="prefix" data-testid="palette-prefix">&gt;</span>
      {:else if palette.mode === "goto"}
        <svg class="search" viewBox="0 0 16 16" aria-hidden="true" data-testid="palette-search">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
      {:else}
        <span class="chip" id="palette-chip-new" data-testid="palette-chip">New session</span>
        {#each palette.steps as step (step.kind)}
          <span class="chip" id="palette-chip-{step.kind}" data-testid="palette-chip" data-step={step.kind}
            >{chipOf(step)}</span
          >
        {/each}
      {/if}
      <input
        bind:this={field}
        value={palette.query}
        oninput={onInput}
        {placeholder}
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={items[cursor] === undefined ? undefined : optionId(items[cursor])}
        aria-describedby={palette.mode === "new"
          ? ["new", ...palette.steps.map((step) => step.kind)].map((id) => `palette-chip-${id}`).join(" ")
          : undefined}
        aria-label={heading}
        data-testid="palette-field"
      />
    </div>
    <div class="list" id="palette-list" role="listbox" aria-label={heading} bind:this={list}>
      {#each sections as section (section.group ?? "")}
        <div
          class="section"
          role={section.group === null ? "presentation" : "group"}
          aria-labelledby={section.group === null ? undefined : `palette-group-${section.start}`}
        >
          {#if section.group !== null}
            <div class="group" id="palette-group-{section.start}" aria-hidden="true" data-testid="palette-group">{section.group}</div>
          {/if}
          {#each section.rows as item, offset (item.id)}
            {@const index = section.start + offset}
            <button
              class="row"
              class:cursor={index === cursor}
              class:off={!pickable(item)}
              id={optionId(item)}
              role="option"
              aria-selected={index === cursor}
              aria-disabled={!pickable(item)}
              tabindex="-1"
              onclick={() => run(item)}
              onpointerdown={(e) => e.preventDefault()}
              onpointermove={(e) => {
                if ((e.movementX !== 0 || e.movementY !== 0) && pickable(item)) chosen = item.id;
              }}
              data-testid="palette-row"
              data-kind={item.kind}
            >
              {#if item.kind === "session"}
                <span
                  class="dot"
                  class:live={isLive(item.session)}
                  class:working={isLive(item.session) && item.session.working}
                  class:dormant={item.session.status === "dormant"}
                  class:unread={item.session.unread}
                  class:permission={item.session.needs === "permission"}
                  data-testid="palette-dot"
                ></span>
              {:else if item.kind === "project" || (item.kind === "choice" && item.step.kind === "project")}
                <svg class="folder" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"
                  />
                </svg>
              {/if}
              <span class="label" data-testid="palette-label">{item.label}</span>
              {#if item.kind === "session"}
                <span class="detail" data-testid="palette-detail">{item.project}</span>
                <span class="end" data-testid="palette-end">{item.when}</span>
              {:else if item.kind === "choice"}
                <span class="detail" data-testid="palette-detail">{item.detail}</span>
                <span class="end" data-testid="palette-end">{item.end}</span>
              {:else if item.kind === "project"}
                <span class="detail"></span>
                <span class="end" data-testid="palette-end">{item.end}</span>
              {:else if item.kind === "attention"}
                <span class="detail">{item.waiting === 0 ? "nothing waiting" : `${item.waiting} waiting`}</span>
                <kbd>{item.chord}</kbd>
              {:else}
                <span class="detail"></span>
                {#if item.chord !== ""}<kbd>{item.chord}</kbd>{/if}
              {/if}
            </button>
          {/each}
        </div>
      {/each}
    </div>
    {#if items.length === 0}
      <p class="note">{nothingOpen ? "Nothing is open." : "Nothing matches."}</p>
    {/if}
    <div class="foot" data-testid="palette-hints">
      {#if palette.mode === "goto"}
        {#if goable}
          <span><kbd>↵</kbd> go to</span>
          <span><kbd>{modifier}↵</kbd> new session in the project</span>
        {:else if items.length > 0}
          <span><kbd>↵</kbd> open</span>
        {/if}
        <span><kbd>&gt;</kbd> commands</span>
        <span><kbd>esc</kbd> close</span>
      {:else if palette.mode === "new"}
        <span><kbd>↵</kbd> {stepsLeft(palette.steps).length === 1 ? "start" : "choose"}</span>
        <span><kbd>⌫</kbd> back</span>
        <span><kbd>esc</kbd> close</span>
      {:else}
        {#if items.length > 0}<span><kbd>↵</kbd> run</span>{/if}
        <span><kbd>esc</kbd> close</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, black 42%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
  }

  .scrim.leaving {
    opacity: 0;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .scrim {
      animation: arrive 110ms ease-out;
      transition: opacity 110ms ease-out;
    }
  }

  @keyframes arrive {
    from {
      opacity: 0;
    }
  }

  .dialog {
    width: min(620px, calc(100vw - 32px));
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    outline: none;
    overflow: hidden;
  }

  .entry {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    font-family: var(--chrome);
    font-size: 13px;
  }

  .prefix {
    flex: none;
    color: var(--accent);
  }

  .search {
    width: 12px;
    height: 12px;
    flex: none;
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  .section {
    display: flex;
    flex-direction: column;
  }

  .chip {
    flex: none;
    padding: 1px 8px;
    border-radius: var(--radius-tag);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11.5px;
    white-space: nowrap;
  }

  input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    outline: none;
  }

  input::placeholder {
    color: var(--ink-3);
  }

  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
  }

  .group {
    padding: 8px 8px 3px;
    font-family: var(--chrome);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .row.cursor {
    background: var(--accent-soft);
    color: var(--ink);
  }

  .row.off {
    color: var(--ink-3);
    cursor: default;
  }

  .label {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .end {
    flex: none;
    margin-left: auto;
    padding-left: 12px;
    font-size: 10.5px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  kbd {
    flex: none;
    margin-left: auto;
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .folder {
    width: 12px;
    height: 12px;
    flex: none;
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1.2;
    stroke-linejoin: round;
  }

  .dot {
    width: var(--dot);
    height: var(--dot);
    flex: none;
    border: 1px solid var(--ink-3);
    border-radius: 50%;
  }

  .dot.live {
    background: var(--add);
    border-color: var(--add);
  }

  .dot.dormant {
    background: var(--dormant);
    border-color: var(--dormant);
  }

  .dot.working {
    animation: breathe 1.2s ease-in-out infinite;
  }

  .dot.unread {
    background: var(--accent);
    border-color: var(--accent);
  }

  .dot.permission {
    background: var(--surface);
    border-color: var(--accent);
    animation: none;
  }

  @keyframes breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.working {
      animation: none;
    }
  }

  .note {
    margin: 0;
    padding: 10px var(--pane-pad);
    font-size: 12px;
    color: var(--ink-3);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 8px var(--pane-pad);
    border-top: 1px solid var(--rule);
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .foot kbd {
    margin: 0;
  }
</style>

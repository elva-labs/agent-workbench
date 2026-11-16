<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Choice } from "$lib/settingChoices";
  import Icon from "./conversation/Icon.svelte";
  import Plain from "./conversation/Plain.svelte";

  /**
   * A small menu of one setting's choices, each with its name, a line on
   * what it does where there is one, and a tick on the one in use: the
   * model, the mode or the effort of an integrated session, wherever it is
   * offered. It opens with the keyboard on the choice in use, and is walked
   * with the arrows, Home and End; Enter picks, and Escape or Tab puts it
   * away, with the owner saying where the keyboard goes then. The choice
   * under the pointer takes the keyboard, so the pointer and the keyboard
   * are one mark. The keyboard going anywhere outside what holds the menu,
   * by a chord or a press, puts it away and leaves the keyboard there.
   *
   * A choice that cannot be taken here is walked to like the others and
   * says why in its line, but picking it does nothing.
   *
   * It opens above what holds it, from its left edge or with `end` from
   * its right, or at a place the owner gives, where what holds it cuts off
   * what overflows it. Opened from the right edge it moves as far as it
   * takes to stay inside the box the owner names, as when what holds it
   * has wrapped to the left of a narrow row.
   */
  interface Props {
    label: string;
    choices: Choice[];
    /** A line under the choices. */
    note?: string | null;
    onpick: (value: string) => void;
    /** Escape or Tab put it away, or the keyboard went elsewhere. */
    onclose: (how: "escape" | "tab" | "away") => void;
    /** Where it stands in the window, by its left edge and its foot. */
    at?: { left: number; bottom: number } | null;
    /** It opens from the right edge of what holds it, for a holder near
        the right of a row. */
    end?: boolean;
    /** What it stays inside when it opens from the right edge. */
    within?: HTMLElement | null;
    /** Opened with the pointer: the choice the keyboard is on is marked
        only while the pointer is on it or once a key is pressed, so a
        menu opened by a press marks nothing until the pointer or a key
        says where. */
    pointer?: boolean;
    testid: string;
    optionTestid: string;
  }

  let {
    label,
    choices,
    note = null,
    onpick,
    onclose,
    at = null,
    end = false,
    within = null,
    pointer = false,
    testid,
    optionTestid,
  }: Props = $props();

  let menu = $state<HTMLDivElement | null>(null);
  let pointing = $state(untrack(() => pointer));

  function items(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [])];
  }

  /** Opened from the right edge, where its left edge stands from what
      holds it, once measured. */
  let shift = $state<number | null>(null);

  /** Puts it at the right edge of what holds it, or as near as it can be
      while inside `within`. */
  function place() {
    if (!end || menu === null) return;
    const holder = menu.parentElement?.getBoundingClientRect();
    if (holder === undefined) return;
    const width = menu.offsetWidth;
    const room = (within ?? document.documentElement).getBoundingClientRect();
    const left = Math.max(room.left, Math.min(holder.right - width, room.right - width));
    shift = left - holder.left;
  }

  onMount(() => {
    place();
    (menu?.querySelector<HTMLButtonElement>("[aria-checked='true']") ?? items()[0])?.focus();
  });

  $effect(() => {
    if (!end) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });

  function onkeydown(e: KeyboardEvent) {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    // Where nothing is marked, the first arrow marks the choice the
    // keyboard is on rather than moving past it unseen.
    const unmarked = pointing && !(all[index]?.matches(":hover") ?? false);
    pointing = false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (unmarked && index >= 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      all[(index + step + all.length) % all.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      all[e.key === "Home" ? 0 : all.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose("escape");
    } else if (e.key === "Tab") {
      onclose("tab");
    }
  }

  function onpointermove(e: PointerEvent) {
    pointing = true;
    const choice = (e.target as Element | null)?.closest<HTMLButtonElement>("[role='menuitemradio']");
    if (choice != null && choice !== document.activeElement) choice.focus({ preventScroll: true });
  }

  function onfocusout(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    const holder = menu?.parentElement ?? menu;
    if (next !== null && holder !== null && !holder.contains(next)) onclose("away");
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  bind:this={menu}
  class="menu"
  data-card
  class:placed={at !== null}
  class:end
  class:pointing
  {onpointermove}
  {onfocusout}
  style:left={at !== null ? `${at.left}px` : shift !== null ? `${shift}px` : undefined}
  style:right={shift !== null ? "auto" : undefined}
  style:bottom={at === null ? undefined : `${at.bottom}px`}
  role="menu"
  aria-label={label}
  {onkeydown}
  data-testid={testid}
>
  {#each choices as choice (choice.value)}
    <button
      role="menuitemradio"
      aria-checked={choice.on}
      aria-disabled={choice.off ? "true" : undefined}
      class:on={choice.on}
      class:off={choice.off}
      onclick={() => {
        if (!choice.off) onpick(choice.value);
      }}
      data-testid={optionTestid}
    >
      <span class="name"><Plain text={choice.name} /></span>
      {#if choice.about}<span class="about"><Plain text={choice.about} /></span>{/if}
      {#if choice.on}<span class="tick"><Icon name="check" size={12} /></span>{/if}
    </button>
  {/each}
  {#if note !== null}
    <p class="menu-note">{note}</p>
  {/if}
</div>

<style>
  .menu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    min-width: 220px;
    max-width: 320px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--paint-surface);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
    font-family: var(--chrome);
    white-space: normal;
    text-transform: none;
    letter-spacing: normal;
  }

  .menu.placed {
    position: fixed;
    z-index: 30;
  }

  /* Wide enough for a line on each choice to sit on one line, and no
     wider than the conversation it opens over. */
  .menu.end {
    left: auto;
    right: 0;
    width: min(330px, calc(100cqi - 32px));
    max-width: none;
  }

  button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 16px;
    align-items: center;
    column-gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--row-size);
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }

  /* The one mark: the choice with the keyboard, which the pointer moves
     too. Opened by a press, it shows only while the pointer is on it,
     until a key is pressed. */
  button:focus {
    background: var(--accent-soft);
    color: var(--ink);
    outline: none;
  }

  .pointing button:focus:not(:hover) {
    background: none;
    color: var(--ink-2);
  }

  .on,
  .pointing .on:focus:not(:hover) {
    color: var(--ink);
  }

  .off,
  .off:focus,
  .pointing .off:focus:not(:hover) {
    color: var(--ink-3);
    cursor: default;
  }

  .off .about {
    color: var(--ink-3);
  }

  .name {
    grid-column: 1;
  }

  .about {
    grid-column: 1;
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-2);
  }

  .tick {
    grid-column: 2;
    grid-row: 1;
    color: var(--accent);
  }

  .menu-note {
    margin: 4px 8px 2px;
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-2);
  }
</style>

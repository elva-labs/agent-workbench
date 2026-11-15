<script lang="ts">
  import { onMount } from "svelte";
  import type { Choice } from "$lib/settingChoices";
  import Icon from "./conversation/Icon.svelte";
  import Plain from "./conversation/Plain.svelte";

  /**
   * A small menu of one setting's choices, each with its name, a line on
   * what it does where there is one, and a tick on the one in use: the
   * model, the mode or the effort of an integrated session, wherever it is
   * offered. It opens with the keyboard on the choice in use, and is walked
   * with the arrows, Home and End; Enter picks, and Escape or Tab puts it
   * away, with the owner saying where the keyboard goes then.
   *
   * It opens above what holds it, or at a place the owner gives, where
   * what holds it cuts off what overflows it.
   */
  interface Props {
    label: string;
    choices: Choice[];
    /** A line under the choices. */
    note?: string | null;
    onpick: (value: string) => void;
    onclose: (how: "escape" | "tab") => void;
    /** Where it stands in the window, by its left edge and its foot. */
    at?: { left: number; bottom: number } | null;
    testid: string;
    optionTestid: string;
  }

  let { label, choices, note = null, onpick, onclose, at = null, testid, optionTestid }: Props = $props();

  let menu = $state<HTMLDivElement | null>(null);

  function items(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [])];
  }

  onMount(() => {
    (menu?.querySelector<HTMLButtonElement>("[aria-checked='true']") ?? items()[0])?.focus();
  });

  function onkeydown(e: KeyboardEvent) {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
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
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  bind:this={menu}
  class="menu"
  class:placed={at !== null}
  style:left={at === null ? undefined : `${at.left}px`}
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
      class:on={choice.on}
      onclick={() => onpick(choice.value)}
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
    background: var(--surface);
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

  button:hover,
  button:focus-visible {
    background: var(--accent-soft);
    color: var(--ink);
    outline: none;
  }

  .on {
    color: var(--ink);
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

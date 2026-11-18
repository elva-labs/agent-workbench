<script lang="ts" module>
  /** The id of a menu's row, for the field to name the marked one by. */
  export function rowId(menu: string, index: number): string {
    return `${menu}-${index}`;
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from "svelte";

  /**
   * A list that completes what is being typed in the field beside it, over
   * the thread and as wide as the composer, for the slash commands and for
   * the files an `@` mentions: rows in groups, one of them
   * marked, and a line saying the keys. The field keeps the keyboard and
   * says which row is marked, so the list is one the field controls: its
   * owner moves the mark with the arrows and takes the marked row with Tab
   * or Enter. A click takes a row, and the pointer moving over one marks it.
   * A press on the list never takes the keyboard from the field.
   *
   * With nothing to list it says why in one line instead; the owner says
   * what it holds to a screen reader, from a live region that stays while
   * the menu comes and goes. It is never taller than the room above the
   * composer in the pane, and scrolls the marked row into view.
   */
  interface Props {
    /** The list's id; a row's is the list's and its place. */
    id: string;
    /** What the list is, for a screen reader. */
    label: string;
    /** The rows in groups, each under its label; a group with none is
        drawn without a head. */
    groups: { label: string; items: T[] }[];
    /** The marked row, by its place among all the rows. */
    active: number;
    key: (item: T) => string;
    /** What a row shows. */
    row: Snippet<[T]>;
    /** Shown in place of the rows when there are none. */
    empty?: Snippet;
    /** What Tab or Enter does to the marked row, in a word. */
    action: string;
    onpick: (index: number) => void;
    onpoint: (index: number) => void;
    testid: string;
    /** A line over the rows, naming what the list is. */
    head?: Snippet;
    /** What stands under the rows, over the keys. */
    foot?: Snippet;
    /** The keys line, where the list takes other keys than Tab and Enter. */
    keys?: Snippet;
  }

  let { id, label, groups, active, key, row, empty, action, onpick, onpoint, testid, head, foot, keys }: Props =
    $props();

  let menu = $state<HTMLDivElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  /** The room above what holds the menu, in the pane it is in. */
  let room = $state<number | null>(null);

  let sections = $derived.by(() => {
    let start = 0;
    return groups.map((group) => {
      const section = { ...group, start };
      start += group.items.length;
      return section;
    });
  });
  let count = $derived(groups.reduce((sum, group) => sum + group.items.length, 0));

  // The menu is never taller than the room between the top of the pane and
  // what holds it, whatever grows: the composer, the pane, the window.
  $effect(() => {
    const holder = menu?.parentElement;
    if (menu === null || holder == null) return;
    const bound = holder.closest<HTMLElement>("[data-session]") ?? document.documentElement;
    const measure = () => {
      room = Math.max(96, holder.getBoundingClientRect().top - bound.getBoundingClientRect().top - 14);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(holder);
    watch.observe(bound);
    return () => watch.disconnect();
  });

  // The marked row stays in view as the arrows move it.
  $effect(() => {
    const marked = list?.querySelector<HTMLElement>(`#${CSS.escape(rowId(id, active))}`);
    marked?.scrollIntoView({ block: "nearest" });
  });
</script>

<div
  bind:this={menu}
  class="menu"
  data-card
  style:max-height={room === null ? undefined : `${room}px`}
  role="presentation"
  onpointerdown={(e) => e.preventDefault()}
  data-testid={testid}
>
  {#if head !== undefined}<div class="top" data-testid="{testid}-head">{@render head()}</div>{/if}
  {#if count === 0}
    <p class="empty" data-testid="{testid}-empty">{@render empty?.()}</p>
  {:else}
    <div class="rows" {id} role="listbox" aria-label={label} bind:this={list}>
      {#each sections as section (section.label)}
        <div class="group" role="group" aria-labelledby={section.label === "" ? undefined : `${id}-group-${section.start}`}>
          {#if section.label !== ""}<p class="head" id="{id}-group-{section.start}" aria-hidden="true">{section.label}</p>{/if}
          {#each section.items as item, offset (key(item))}
            {@const index = section.start + offset}
            <button
              class="row"
              class:on={index === active}
              id={rowId(id, index)}
              role="option"
              tabindex="-1"
              aria-selected={index === active}
              onclick={() => onpick(index)}
              onpointermove={(e) => {
                if ((e.movementX !== 0 || e.movementY !== 0) && index !== active) onpoint(index);
              }}
              data-testid="{testid}-row"
            >
              {@render row(item)}
            </button>
          {/each}
        </div>
      {/each}
    </div>
    {#if foot !== undefined}<div class="foot" data-testid="{testid}-foot">{@render foot()}</div>{/if}
    <p class="keys" aria-hidden="true">
      {#if keys !== undefined}
        {@render keys()}
      {:else}
        <span><kbd>↑</kbd> <kbd>↓</kbd> choose</span>
        <span><kbd>⇥</kbd> or <kbd>↵</kbd> {action}</span>
        <span><kbd>esc</kbd> close</span>
      {/if}
    </p>
  {/if}
</div>

<style>
  .menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    max-width: 560px;
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
    cursor: default;
  }

  .rows {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .head {
    margin: 6px 8px 2px;
    font-size: calc(var(--meta-size) - 0.5px);
    font-weight: 600;
    letter-spacing: var(--label-track-fine, 0);
    text-transform: var(--label-case, none);
    color: var(--ink-3);
  }

  .group:first-child .head {
    margin-top: 2px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr) auto;
    align-items: baseline;
    column-gap: 10px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--row-size);
    color: var(--ink-2);
    text-align: left;
    outline: none;
    cursor: pointer;
  }

  .row.on {
    background: var(--accent-soft);
    color: var(--ink);
  }

  .top {
    flex: none;
    margin: 2px 8px 4px;
  }

  .foot {
    flex: none;
    margin: 4px 8px 2px;
  }

  .keys {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 4px -4px -4px;
    padding: 6px 10px;
    border-top: 1px solid var(--divider, var(--rule));
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-3);
  }

  .empty {
    margin: 0;
    padding: 8px 8px 6px;
    font-size: var(--row-size);
    color: var(--ink-2);
  }

  kbd,
  .keys :global(kbd),
  .empty :global(kbd) {
    font: inherit;
    font-size: calc(var(--meta-size) - 1px);
    padding: 0 4px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink-2);
    text-transform: none;
    letter-spacing: 0;
  }
</style>

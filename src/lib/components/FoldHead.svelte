<script lang="ts">
  /**
   * The line a fold is headed by: the chevron, the title, the detail beside
   * it, the count, and the actions the fold carries while it is open.
   *
   * The width is shared in a fixed order. The label comes first and keeps
   * all of its text, then the button that is not an action, then as many
   * actions as there is room for, from the left. Whatever is left over goes
   * under a "⋯" button at the end of the line. Only when the label and that
   * button together are more than the line can hold does the detail give
   * way and get cut, and the title after it.
   */
  import type { Snippet } from "svelte";
  import type { PluginAction } from "$lib/core";

  interface Props {
    /** Whether the fold this line heads stands open. */
    open: boolean;
    title: string;
    /** A short line beside the title, or nothing. */
    detail: string | null;
    count: number;
    /** The actions the line carries while it is open. */
    actions: PluginAction[];
    onToggle: () => void;
    onAct: (action: PluginAction) => void;
    /** The id the tree's cursor scrolls to, on the fold button. */
    foldId?: string;
    /** Whether the tree's cursor stands on the fold button. */
    cursor?: boolean;
    testId: string;
    /** The lighter line a group inside a plugin's fold is drawn as. */
    group?: boolean;
    /** A button that is not an action: it stands wherever the room goes. */
    lead?: Snippet;
  }

  let {
    open,
    title,
    detail,
    count,
    actions,
    onToggle,
    onAct,
    foldId,
    cursor = false,
    testId,
    group = false,
    lead,
  }: Props = $props();

  /** Between the label and the actions, between the actions, and the room
      the actions keep at the line's end. */
  const HEAD_GAP = 6;
  const ACTION_GAP = 2;
  const EDGE = 6;

  let head = $state<HTMLElement | null>(null);
  let fold = $state<HTMLElement | null>(null);
  let leadSlot = $state<HTMLElement | null>(null);
  let strip = $state<HTMLElement | null>(null);
  /** The line's own width, which the pane decides rather than the content. */
  let width = $state(0);
  /** How many of the actions stand on the line; the rest are under the "⋯".
      All of them, until they have been measured. */
  let shown = $state(Number.POSITIVE_INFINITY);
  let menuOpen = $state(false);

  let over = $derived(actions.slice(shown));

  $effect(() => {
    const el = head;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width;
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  /** What the label would take with nothing cut: its parts' own widths, the
      gaps between them and the line's padding. `scrollWidth` rounds down, so
      each part is given back the pixel it may have lost. */
  function natural(label: HTMLElement) {
    const style = getComputedStyle(label);
    const gap = parseFloat(style.columnGap) || 0;
    const parts = Array.from(label.children) as HTMLElement[];
    const text = parts.reduce((sum, part) => sum + part.scrollWidth + 1, 0);
    return (
      text +
      gap * Math.max(0, parts.length - 1) +
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight)
    );
  }

  // What fits: the actions are measured once off screen at their own width,
  // and taken from the left while there is room. Anything left over needs
  // the button that holds it, so the last ones give way until that fits too.
  $effect(() => {
    const label = fold;
    const kit = strip;
    const room = width;
    const all = actions.length;
    // The label's text is what the actions are left the room beside.
    void title;
    void detail;
    void count;
    if (label === null || kit === null || !open || all === 0 || room === 0) {
      if (shown !== all) shown = all;
      return;
    }
    const widths = Array.from(kit.children, (child) => (child as HTMLElement).offsetWidth);
    const more = widths.pop() ?? 0;
    const leadWidth = leadSlot === null ? 0 : leadSlot.offsetWidth;
    const gapFor = (index: number) => (index > 0 || leadWidth > 0 ? ACTION_GAP : 0);
    const left = room - natural(label) - HEAD_GAP - EDGE - leadWidth;
    let used = 0;
    let fits = 0;
    while (fits < all && used + widths[fits] + gapFor(fits) <= left) {
      used += widths[fits] + gapFor(fits);
      fits += 1;
    }
    if (fits < all) {
      while (fits > 0 && used + more + gapFor(fits) > left) {
        fits -= 1;
        used -= widths[fits] + gapFor(fits);
      }
    }
    if (shown !== fits) shown = fits;
  });

  // Nothing left over, nothing to hold: the menu goes with the button.
  $effect(() => {
    if (over.length === 0 && menuOpen) menuOpen = false;
  });

  // The button that opens the menu leaves the keyboard where it was, so the
  // key that closes it is watched for on the window, ahead of the pane that
  // would otherwise read it.
  $effect(() => {
    if (!menuOpen) return;
    const shut = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      menuOpen = false;
    };
    window.addEventListener("keydown", shut, true);
    return () => window.removeEventListener("keydown", shut, true);
  });

  function pick(action: PluginAction) {
    menuOpen = false;
    onAct(action);
  }
</script>

<div class="head" class:group bind:this={head}>
  <button
    id={foldId}
    class="fold"
    class:cursor
    tabindex="-1"
    bind:this={fold}
    onpointerdown={(e) => e.preventDefault()}
    onclick={onToggle}
    aria-expanded={open}
    data-testid={testId}
  >
    <span class="chevron">{open ? "▾" : "▸"}</span>
    <span class="fold-title">{title}</span>
    {#if detail !== null}
      <span class="fold-detail">· {detail}</span>
    {/if}
    {#if count > 0}
      <span class="fold-count">({count})</span>
    {/if}
  </button>
  <span class="head-actions">
    {#if lead}
      <span class="lead" bind:this={leadSlot}>{@render lead()}</span>
    {/if}
    {#if open}
      {#each actions.slice(0, shown) as action (action.id)}
        <button
          class="head-action"
          tabindex="-1"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => onAct(action)}
          data-action={action.id}
          data-testid="plugin-section-action">{action.label}</button
        >
      {/each}
      {#if over.length > 0}
        <span class="more-slot">
          <button
            class="head-action more"
            tabindex="-1"
            onpointerdown={(e) => e.preventDefault()}
            onclick={() => (menuOpen = !menuOpen)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More actions"
            data-testid="plugin-actions-more">⋯</button
          >
          {#if menuOpen}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div class="scrim" onclick={() => (menuOpen = false)}></div>
            <div class="menu" role="menu" data-testid="plugin-actions-menu">
              {#each over as action (action.id)}
                <button
                  role="menuitem"
                  onpointerdown={(e) => e.preventDefault()}
                  onclick={() => pick(action)}
                  data-action={action.id}
                  data-testid="plugin-menu-action">{action.label}</button
                >
              {/each}
            </div>
          {/if}
        </span>
      {/if}
    {/if}
  </span>
  <!-- Every action at its own width, off the line and out of the way, which
       is what says how many of them the line has room for. -->
  {#if open && actions.length > 0}
    <span class="strip" aria-hidden="true" bind:this={strip}>
      {#each actions as action (action.id)}
        <button class="head-action" tabindex="-1">{action.label}</button>
      {/each}
      <button class="head-action more" tabindex="-1">⋯</button>
    </span>
  {/if}
</div>

<style>
  .head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--fold-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 6px var(--pane-pad);
  }

  .fold:hover {
    color: var(--ink);
  }

  /* A group inside a plugin's fold: lighter, and a step in under it. */
  .head.group .fold {
    padding: 3px var(--row-pad-x) 3px var(--row-indent);
    font-size: var(--label-size);
  }

  /* The title says which plugin or section this is, so it keeps its own
     text and the detail beside it is what gives way on a line too narrow
     to hold the label and the "⋯" button together. */
  .fold-title,
  .fold-count {
    flex: none;
  }

  .fold-detail {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-3);
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    padding-right: 6px;
  }

  .lead {
    display: inline-flex;
  }

  .head-action {
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 5px;
    white-space: nowrap;
  }

  .head-action:hover {
    color: var(--accent);
    background: var(--surface-2);
  }

  /* The actions measured at their own width, left of the line where an
     overflow neither shows nor scrolls. */
  .strip {
    position: absolute;
    top: 0;
    right: 100%;
    display: flex;
    gap: 2px;
    visibility: hidden;
    pointer-events: none;
    white-space: nowrap;
  }

  .more-slot {
    position: relative;
    display: inline-flex;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 4;
  }

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 148px;
    padding: 4px 0;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px color-mix(in srgb, black 25%, transparent);
  }

  .menu button {
    display: flex;
    width: 100%;
    align-items: baseline;
    gap: 16px;
    padding: 5px var(--pane-pad);
    border: 0;
    background: none;
    font-size: 12.5px;
    color: var(--ink-2);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .menu button:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
</style>

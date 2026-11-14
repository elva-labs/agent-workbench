<script lang="ts">
  /**
   * The editor's tabs, heading its column, and the views control at the
   * end: Edit, Diff when git changed the file, and Preview for Markdown,
   * walked with the view chord. A tab only looked at is drawn in italics
   * until it is edited or double-clicked; one with unsaved edits carries a
   * dot where its close button is.
   *
   * While what the agent presented, a plugin's page or the browser takes the
   * editor's place, no tab is drawn in front and the views control goes. The
   * tab in front is always scrolled into view; tabs narrow before they
   * overflow, and an edge with tabs past it fades.
   */
  import { tick } from "svelte";
  import {
    activate,
    activeTab,
    closeTab,
    editor,
    keep,
    otherKindShown,
    setTabView,
    tabKey,
    viewsOf,
    type Tab,
    type TabView,
  } from "$lib/editor.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import { lastSegment } from "$lib/paths";

  let other = $derived(otherKindShown());
  let front = $derived(other ? null : activeTab());
  let views = $derived(viewsOf(front));

  let strip = $state<HTMLDivElement | null>(null);
  let fadeStart = $state(false);
  let fadeEnd = $state(false);

  /** Which edges have tabs past them. */
  function measure() {
    if (strip === null) return;
    fadeStart = strip.scrollLeft > 1;
    fadeEnd = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  }

  $effect(() => {
    if (strip === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  });

  // The tab in front is never hidden past an edge.
  $effect(() => {
    const key = editor.active;
    editor.tabs.length;
    void tick().then(() => {
      if (strip === null || key === null) return;
      const at = [...strip.querySelectorAll<HTMLElement>("[data-testid='editor-tab']")].find(
        (tab) => tab.dataset.key === key,
      );
      at?.scrollIntoView({ block: "nearest", inline: "nearest" });
      measure();
    });
  });

  const LABELS: Record<TabView, string> = { edit: "Edit", diff: "Diff", preview: "Preview" };

  /** A tab's name, and the folder it is in when another tab has the same
      name. */
  function named(tab: Tab): { name: string; folder: string | null } {
    const name = lastSegment(tab.path);
    const twin = editor.tabs.some((other) => other !== tab && lastSegment(other.path) === name);
    if (!twin) return { name, folder: null };
    const cut = tab.path.lastIndexOf("/");
    return { name, folder: cut === -1 ? null : lastSegment(tab.path.slice(0, cut)) };
  }

  function onAuxClick(e: MouseEvent, key: string) {
    if (e.button !== 1) return;
    e.preventDefault();
    closeTab(key);
  }
</script>

<div class="row" data-testid="tab-row">
  <div
    class="tabs"
    class:fade-start={fadeStart}
    class:fade-end={fadeEnd}
    role="tablist"
    aria-label="Open files"
    bind:this={strip}
    onscroll={measure}
  >
    {#each editor.tabs as tab (tabKey(tab))}
      {@const key = tabKey(tab)}
      {@const label = named(tab)}
      {@const dirty = editor.buffers[key]?.dirty === true}
      <div
        class="tab"
        class:on={!other && editor.active === key}
        class:preview={tab.preview}
        class:dirty
        role="tab"
        tabindex="-1"
        aria-selected={!other && editor.active === key}
        title={tab.path}
        onclick={() => void activate(key)}
        ondblclick={() => keep(key)}
        onauxclick={(e) => onAuxClick(e, key)}
        onkeydown={(e) => {
          if (e.key === "Enter") void activate(key);
        }}
        data-testid="editor-tab"
        data-path={tab.path}
        data-key={key}
      >
        <span class="name">{label.name}</span>
        {#if label.folder !== null}<span class="folder">{label.folder}</span>{/if}
        <button
          class="close"
          tabindex="-1"
          onclick={(e) => {
            e.stopPropagation();
            closeTab(key);
          }}
          aria-label={dirty ? `Close ${label.name}, which has unsaved edits` : `Close ${label.name}`}
          title={dirty ? "Unsaved" : "Close"}
          data-testid="editor-tab-close"
        >
          {#if dirty}
            <i class="dot" data-testid="editor-tab-dirty"></i>
          {/if}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    {/each}
  </div>
  {#if front !== null}
    <div
      class="views"
      role="radiogroup"
      aria-label="How the file is shown"
      title="Walk the views  {describe(chordFor('view'))}"
      data-testid="editor-views"
    >
      {#each (["edit", "diff", "preview"] as const).filter((option) => option !== "preview" || views.includes("preview")) as option (option)}
        <button
          role="radio"
          aria-checked={front.view === option}
          class:on={front.view === option}
          disabled={!views.includes(option)}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => setTabView(option)}
          data-testid="editor-view-{option}">{LABELS[option]}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Within the header's height, as the corner is: the tabs overhang its
     padding rather than make the row taller than the headers beside it. */
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    align-self: center;
    margin: -6px 0;
  }

  .tabs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tabs.fade-start {
    mask-image: linear-gradient(to right, transparent, black 24px);
  }

  .tabs.fade-end {
    mask-image: linear-gradient(to left, transparent, black 24px);
  }

  .tabs.fade-start.fade-end {
    mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent);
  }

  /* Tabs narrow to a name's first letters before the row overflows. */
  .tab {
    flex: 0 1 auto;
    min-width: 72px;
    max-width: 220px;
    display: flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 4px 0 10px;
    border-radius: var(--radius);
    font-family: var(--chrome);
    font-size: var(--row-size);
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    white-space: nowrap;
    cursor: default;
  }

  .tab:hover {
    background: var(--surface-2);
    color: var(--ink-2);
  }

  .tab.on {
    background: var(--surface-2);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--head-rule);
  }

  .tab.preview .name {
    font-style: italic;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .close {
    flex: none;
  }

  .folder {
    color: var(--ink-3);
    font-size: 0.92em;
  }

  .close {
    position: relative;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .close svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .close:hover {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    color: var(--ink);
  }

  .tab:not(.on):not(:hover) .close svg {
    visibility: hidden;
  }

  /* Unsaved: a dot where the close button is, which turns back into the
     button under the pointer. */
  .dot {
    position: absolute;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ink-2);
  }

  .tab.dirty .close svg {
    visibility: hidden;
  }

  .tab.dirty .close:hover svg {
    visibility: visible;
  }

  .tab.dirty .close:hover .dot {
    display: none;
  }

  .views {
    flex: none;
    display: flex;
    padding: 2px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--surface-2) 70%, var(--ink) 6%);
  }

  .views button {
    padding: 1px 9px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    line-height: 18px;
    color: var(--ink-3);
    cursor: pointer;
  }

  .views button:hover:not(:disabled) {
    color: var(--ink);
  }

  .views button.on {
    background: var(--surface);
    color: var(--ink);
    font-weight: var(--btn-weight);
    box-shadow: 0 0 0 1px var(--head-rule);
  }

  .views button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { isMac } from "$lib/keymap";
  import { CONTROLS_INSET, layout, focusPane, leftmost, type PaneId } from "$lib/layout.svelte";

  interface Props {
    id: PaneId;
    title: string;
    meta?: string;
    /** Controls that live in the header, after the title. */
    head?: Snippet;
    /** No header of its own: the pane names itself somewhere in its body,
        and the row the header would take goes to the content. */
    bare?: boolean;
    children: Snippet;
  }

  let { id, title, meta, head, bare = false, children }: Props = $props();

  let focused = $derived(layout.focus === id);

  // On macOS the window has no title bar of its own: the traffic lights sit
  // over the header of whichever pane is at the left edge, and the headers
  // are what you grab to move the window.
  const mac = isMac();
  let inset = $derived(mac && leftmost() === id);
</script>

<section
  class="pane"
  class:focused
  data-pane={id}
  aria-label={title}
  onpointerdown={() => focusPane(id)}
  onfocusin={() => focusPane(id)}
>
  {#if !bare}
    <header class:inset data-tauri-drag-region>
      <span class="title" data-tauri-drag-region>{title}</span>
      {#if head}<div class="head">{@render head()}</div>{/if}
      {#if meta}<span class="meta" data-tauri-drag-region>{meta}</span>{/if}
    </header>
  {/if}
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--pane-radius);
    overflow: hidden;
  }

  .pane.focused {
    border-color: var(--accent);
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  /* The frame's padding and the pane's border are already part of the inset. */
  header.inset {
    padding-left: calc(var(--controls-inset) - var(--frame-pad) - 1px);
  }

  .title,
  .meta {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pane.focused .title {
    color: var(--accent);
  }

  .head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>

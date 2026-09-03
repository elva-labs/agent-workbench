<script lang="ts">
  import type { Snippet } from "svelte";
  import { layout, focusPane, type PaneId } from "$lib/layout.svelte";

  interface Props {
    id: PaneId;
    title: string;
    meta?: string;
    /** Controls that live in the header, after the title. */
    head?: Snippet;
    children: Snippet;
  }

  let { id, title, meta, head, children }: Props = $props();

  let focused = $derived(layout.focus === id);
</script>

<section
  class="pane"
  class:focused
  data-pane={id}
  aria-label={title}
  onpointerdown={() => focusPane(id)}
  onfocusin={() => focusPane(id)}
>
  <header>
    <span class="title">{title}</span>
    {#if head}<div class="head">{@render head()}</div>{/if}
    {#if meta}<span class="meta">{meta}</span>{/if}
  </header>
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

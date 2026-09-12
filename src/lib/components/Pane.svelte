<script lang="ts">
  import type { Snippet } from "svelte";
  import { core } from "$lib/core";
  import { isMac } from "$lib/keymap";
  import {
    CONTROLS_INSET,
    layout,
    focusPane,
    leftmost,
    rightmost,
    type PaneId,
  } from "$lib/layout.svelte";

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
  // Elsewhere the window is undecorated and the app draws the controls
  // itself, at the end of the rightmost header, where the platform has them.
  let controls = $derived(!mac && !bare && rightmost() === id);
  // And a menu button at the start of the leftmost, where macOS has its
  // lights: the native popup that stands in for a menu bar.
  let appMenu = $derived(!mac && !bare && leftmost() === id);

  function openAppMenu() {
    core()
      .openAppMenu()
      .catch(() => {});
  }

  function control(action: "minimize" | "maximize" | "close") {
    core()
      .windowControl(action)
      .catch(() => {});
  }
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
    <header class:inset class:leads={appMenu} class:lone={!head && !meta} data-tauri-drag-region>
      {#if appMenu}
        <button class="app-menu" onclick={openAppMenu} aria-label="Menu" title="Menu" data-testid="app-menu">
          <svg viewBox="0 0 12 10" aria-hidden="true"><path d="M0 1h12M0 5h12M0 9h12" /></svg>
        </button>
      {/if}
      <span class="title" data-tauri-drag-region>{title}</span>
      {#if head}<div class="head">{@render head()}</div>{/if}
      {#if meta}<span class="meta" data-tauri-drag-region>{meta}</span>{/if}
      {#if controls}
        <div class="controls" data-testid="window-controls">
          <button onclick={() => control("minimize")} aria-label="Minimize" title="Minimize">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" /></svg>
          </button>
          <button onclick={() => control("maximize")} aria-label="Maximize" title="Maximize">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5h9v9h-9z" /></svg>
          </button>
          <button class="close" onclick={() => control("close")} aria-label="Close" title="Close">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
          </button>
        </div>
      {/if}
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
    margin: var(--pane-margin);
    background: var(--pane-bg);
    border: 1px solid var(--pane-border);
    border-radius: var(--radius-pane);
    box-shadow: var(--pane-shadow);
    overflow: hidden;
  }

  .pane.focused {
    border-color: var(--pane-border-on);
    box-shadow: var(--pane-shadow-on);
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  /* A header carrying nothing but the menu button and its own title has
     nothing to spread itself against, so where the title lands is the look's
     to say. */
  header.leads.lone {
    justify-content: var(--title-align);
  }

  /* The frame's padding and the pane's border are already part of the inset. */
  header.inset {
    padding-left: calc(var(--controls-inset) - var(--frame-pad) - 1px);
  }

  header.leads {
    padding-left: 0;
  }

  .app-menu {
    align-self: stretch;
    width: 40px;
    margin: -9px 2px -9px 0;
    border: 0;
    background: none;
    color: var(--ink-2);
    cursor: default;
    display: grid;
    place-items: center;
  }

  .app-menu svg {
    width: 12px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
  }

  .app-menu:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  /* Three buttons the height of the header, flush with the pane's edge, as
     the platform draws them: a plain hover, and red for close. */
  .controls {
    display: flex;
    align-self: stretch;
    margin: -9px calc(-1 * var(--pane-pad)) -9px 4px;
  }

  .controls button {
    width: 40px;
    border: 0;
    background: none;
    color: var(--ink-2);
    cursor: default;
    display: grid;
    place-items: center;
  }

  .controls svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
  }

  .controls button:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .controls button.close:hover {
    background: #c42b1c;
    color: #ffffff;
  }

  .title,
  .meta {
    font-family: var(--chrome);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title {
    font-size: var(--title-size);
    font-weight: var(--title-weight);
    color: var(--title-color);
  }

  .meta {
    font-size: var(--meta-size);
  }

  .pane.focused .title {
    color: var(--title-color-on);
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

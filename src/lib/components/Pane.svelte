<script lang="ts">
  import type { Snippet } from "svelte";
  import Corner from "$lib/components/Corner.svelte";
  import { core } from "$lib/core";
  import { isMac } from "$lib/keymap";
  import { compact } from "$lib/compact.svelte";
  import { keeps, letters } from "$lib/giveWay";
  import {
    WINDOW_CONTROLS,
    layout,
    focusPane,
    besideSessions,
    rightmost,
    sessionsShown,
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
    /** The width the title's part of the header takes, for a pane whose
        body is in columns: the title heads the first and `head` the rest,
        with the column's edge running up through the header. */
    titleWidth?: string | null;
    /** Controls at the end of the title's part, in a header in columns. */
    cellEnd?: Snippet;
    children: Snippet;
  }

  let { id, title, meta, head, bare = false, titleWidth = null, cellEnd, children }: Props = $props();

  let focused = $derived(layout.focus === id);

  // On macOS the window has no title bar of its own: the traffic lights sit
  // over the header at the left edge, and the headers are what you grab to
  // move the window. Open, the sessions pane's header holds them; the header
  // of the pane beside its column clears them by whatever the column, folded
  // or on its way, leaves short of them, so its title stands still as the
  // column moves. In compact mode the pane beside its edge leads the
  // window and clears them in the same way, and the pane drawn over it
  // keeps their room whether it is in or on its way out. In full screen the
  // lights are in a bar of their own, and no header keeps room for them.
  const mac = isMac();
  let beside = $derived(id === besideSessions());
  let inset = $derived(
    mac && !layout.fullScreen && (id === "sessions" ? compact.on || sessionsShown() : beside),
  );
  // Elsewhere the window is undecorated and the app draws the controls
  // itself, at the end of the rightmost header, where the platform has them.
  let controls = $derived(!mac && !bare && rightmost() === id);
  // The right pane's button and the mode switch stand at the same end, on
  // every platform, before the window controls.
  let corner = $derived(!bare && rightmost() === id);
  // And a menu button at the start of the sessions pane's header, where
  // macOS has its lights, open or folded: the native popup that stands in
  // for a menu bar. In compact mode the header that leads the window holds
  // it too, and the pane drawn over it holds its own in the same place.
  let appMenu = $derived(!mac && !bare && (id === "sessions" || (compact.on && beside)));

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
    <header
      class:inset
      class:beside
      class:leads={appMenu}
      class:controlled={controls}
      class:cornered={corner}
      class:lone={!head && !meta}
      class:columns={titleWidth !== null}
      style:--title-w={titleWidth}
      style:--controls-w={controls ? `${WINDOW_CONTROLS}px` : null}
      data-tauri-drag-region
    >
      {#snippet menuButton()}
        <button class="app-menu" onclick={openAppMenu} aria-label="Menu" title="Menu" data-testid="app-menu">
          <svg viewBox="0 0 12 10" aria-hidden="true"><path d="M0 1h12M0 5h12M0 9h12" /></svg>
        </button>
      {/snippet}
      {#if titleWidth !== null}
        <div class="cell" data-tauri-drag-region>
          {#if appMenu}{@render menuButton()}{/if}
          <span class="title" data-tauri-drag-region>{title}</span>
          {#if meta}<span class="meta" use:letters={meta} data-tauri-drag-region>{meta}</span>{/if}
          {#if cellEnd}<div class="cell-end">{@render cellEnd()}</div>{/if}
        </div>
        {#if head}<div class="head">{@render head()}</div>{/if}
      {:else}
        {#if appMenu}{@render menuButton()}{/if}
        <span class="title" data-tauri-drag-region>{title}</span>
        {#if head}<div class="head" use:keeps>{@render head()}</div>{/if}
        {#if meta}<span class="meta" use:letters={meta} data-tauri-drag-region>{meta}</span>{/if}
      {/if}
      {#if corner}<Corner />{/if}
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
    border: var(--pane-edge) solid var(--pane-border);
    border-radius: var(--radius-pane);
    box-shadow: var(--pane-shadow);
    overflow: hidden;
  }

  .pane.focused {
    border-color: var(--pane-border-on);
    box-shadow: var(--pane-shadow-on);
  }

  /* A card stands on the ground under its header and holds what the pane
     holds: in the modern look the header lies on the ground above it and
     the card's top edge stands where the rule under the header would. The
     terminal look's box is the pane itself and the card is not drawn. */
  .body {
    position: relative;
    background: var(--card-bg);
    border-radius: var(--card-radius);
    box-shadow: var(--card-shadow);
  }

  /* The focused card's accent runs along its top and down into its
     rounded corners, where it ends square. It and the outline stand over
     everything the card holds, whose layers stay below theirs, and under
     what stands over the panes from 5 up: a card's own menus, then the
     peeked sessions pane at 6, then an agent's question at 7. */
  .pane.focused > .body::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 4;
    height: var(--card-radius);
    border: var(--card-mark) solid var(--accent);
    border-bottom: 0;
    border-radius: var(--card-radius) var(--card-radius) 0 0;
    pointer-events: none;
  }

  /* Where the system asks for more contrast the card takes an outline,
     drawn over what it holds. */
  .body::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 3;
    border: 1px solid var(--card-edge);
    border-radius: inherit;
    pointer-events: none;
  }

  /* Over a card the header and the card's lift are free to stand past the
     pane's box: the card clips what it holds. */
  :global(:root[data-look="modern"]) .pane:not([data-pane="sessions"]) {
    overflow: visible;
  }

  /* --lead is the room before the title: the pane's padding, or what the
     macOS window controls need. A header in columns gives it to its first
     cell instead. Every header is the look's one height, the rule under it
     included, and its title's line sits in the middle of it, so the titles
     stand on one line across the window whatever a header holds. */
  header {
    --lead: var(--pane-pad);
    --head-pad: calc((var(--head-height) - 1px - var(--title-size) * var(--line-ui)) / 2);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    height: var(--head-height);
    padding: var(--head-pad) var(--pane-pad) var(--head-pad) var(--lead);
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
    --lead: calc(var(--controls-inset) - var(--frame-pad-left) - var(--pane-edge));
  }

  header.inset.beside {
    --lead: max(
      var(--pane-pad),
      calc(var(--controls-inset) - var(--frame-pad-left) - var(--pane-edge) - var(--sessions-col))
    );
  }

  header.leads {
    --lead: 0px;
  }

  /* In columns: the first cell is as wide as the column under it and takes
     the lead. */
  header.columns {
    padding-left: 0;
    gap: 0;
  }

  .cell {
    flex: none;
    width: var(--title-w);
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    align-self: stretch;
    margin: calc(-1 * var(--head-pad)) 0;
    padding: var(--head-pad) 10px var(--head-pad) var(--lead);
    overflow: hidden;
  }

  header.columns .head {
    padding-left: 8px;
  }

  .cell .title {
    flex: 0 1 auto;
    min-width: 0;
  }

  .cell-end {
    margin-left: auto;
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    align-self: center;
    margin-block: -6px;
  }

  .app-menu {
    align-self: stretch;
    flex: none;
    width: 40px;
    margin: calc(-1 * var(--head-pad)) 2px calc(-1 * var(--head-pad)) 0;
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
     the platform draws them: a plain hover, and red for close. They stand
     out of the header's flow and it keeps their room, so what it spreads
     out never comes between them and the corner: the corner ends the
     pane's padding before them in every header, as it ends that far
     before the header's end where there are none. */
  header.controlled {
    position: relative;
    padding-right: calc(var(--controls-w) + var(--pane-pad));
  }

  .controls {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--controls-w);
    display: flex;
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

  /* In the modern look the header row is the window's own band of ground,
     so the buttons stand flush in the window's corner, the band's height,
     past the frame's padding and the pane's edge, and the header keeps
     only the room they take inside it. */
  :global(:root[data-look="modern"]) .controls {
    position: fixed;
    top: 0;
    right: 0;
    bottom: auto;
    z-index: 11;
    height: calc(var(--frame-pad-top) + var(--pane-edge) + var(--head-height));
  }

  :global(:root[data-look="modern"]) header.controlled {
    padding-right: calc(var(--controls-w) + var(--pane-pad) - var(--frame-pad) - var(--pane-edge));
  }

  /* Where no window controls come after it, the corner ends on the card's
     right edge, so the switch stands in line with the card under it. */
  :global(:root[data-look="modern"]) header.cornered:not(.controlled) {
    padding-right: 0;
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

  /* Short of room the meta gives way before the name: it takes only what
     the name and the controls leave, and the name narrows once it is gone.
     It stands where the room leaves it: at the header's end, or midway to
     the corner. */
  header > .meta,
  .cell .meta {
    flex: 1 1 0;
    min-width: 0;
  }

  header > .meta {
    text-align: end;
  }

  /* Beside a head, short of room, the parts give way in turn: what the
     head holds beyond what it keeps (a workflow's name), then the meta,
     then what the head keeps (the
     place in the workflow, the words of a run's chip), and the title
     last. The room the head keeps beyond its text, a run chip's pips,
     stays until the title has gone. The head starts from what
     it keeps and has the room left over; the meta keeps its own width; and
     the shrink factors are so far apart that each gives way to nothing
     before the one before it has gone. */
  header:not(.columns) > .head {
    flex: 1 1000000 var(--keep, 0px);
    min-width: var(--least, 0px);
  }

  header > .head ~ .meta {
    flex: 0 1000000000000 auto;
  }

  header.cornered > .meta {
    text-align: center;
  }

  .meta:global(.cut) {
    visibility: hidden;
  }

  .pane.focused header {
    box-shadow: var(--head-mark-on);
  }

  .pane.focused .title {
    color: var(--title-color-on);
  }

  /* What the head holds is centred on the title's line rather than set on
     its baseline: a head that starts with an icon has the icon's foot for
     a baseline, which would pull the title and the meta below the middle. */
  .head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    align-self: center;
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

<script lang="ts">
  import { tick, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import {
    DEFAULT,
    MIN,
    applyLayout,
    focusPane,
    hideTerminal,
    layout,
    returnFocus,
    saveLayout,
    terminalVisible,
  } from "$lib/layout.svelte";
  import {
    activeShell,
    close,
    create,
    equalize,
    forProject,
    groupOf,
    groupsFor,
    label,
    launch,
    resizeSplit,
    select,
    share,
    shownGroup,
    split,
    statusMessage,
    terminals,
    type Shell,
  } from "$lib/terminals.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { sizeOf } from "$lib/zoom.svelte";

  let current = $derived(activeShell());
  let shown = $derived(shownGroup());
  let focused = $derived(layout.focus === "terminal");
  let groups = $derived(workspace.active === null ? [] : groupsFor(workspace.active));

  /** What the shown group divides between its shells. */
  let shellsWidth = $state(0);

  // Asking for the panel is asking for a shell: it opens with one when the
  // project has none. Only on showing it or on changing project, never as a
  // reaction to a shell going, or one that exits at once would be a loop.
  $effect(() => {
    const visible = terminalVisible();
    const project = workspace.active;
    untrack(() => {
      if (visible && project !== null && forProject(project).length === 0) create(project);
    });
  });

  function another() {
    if (workspace.active !== null) create(workspace.active);
  }

  function beside() {
    if (current !== null) split(current.key);
  }

  let rows = $state<HTMLDivElement | null>(null);

  /** Whether the arrows have walked the rows since the keyboard came onto
      them. Only then does Delete close a shell, so a key meant for a shell
      never closes one. */
  let walked = false;

  /** A row picks its shell and puts the keyboard in it, by a click as by
      Enter or Space. A row that had the keyboard lets it go, since the
      shell yields to a control of its own pane. */
  function choose(key: string) {
    select(key);
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && rows?.contains(holder)) holder.blur();
    focusPane("terminal");
  }

  /** The arrows walk the rows, and Delete then closes the shell under the
      keyboard, which stays on the rows; with the last shell gone, it goes
      back to the pane the panel hands the focus to. */
  async function onRowKeydown(e: KeyboardEvent, key: string) {
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
      walked = true;
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    if (!walked) return;
    close(key);
    await tick();
    const next =
      rows?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      rows?.querySelector<HTMLElement>('[role="option"]');
    if (next) {
      next.focus();
      walked = true;
    } else returnFocus();
  }

  function onRowFocusout(e: FocusEvent) {
    if (!(e.relatedTarget instanceof Node && rows?.contains(e.relatedTarget))) walked = false;
  }

  /** Whether this shell has a neighbour on its left in the shown group. */
  function afterFirst(shell: Shell) {
    return shell.group === shown && groupOf(shell.key)[0] !== shell;
  }

  function resizeList(dx: number) {
    layout.terminalList = Math.max(MIN.terminalList, layout.terminalList - dx);
    applyLayout(layout.width, layout.height);
  }

  function resetList() {
    layout.terminalList = DEFAULT.terminalList;
    applyLayout(layout.width, layout.height);
    saveLayout();
  }

  function dot(shell: Shell) {
    return shell.status === "running" ? "live" : shell.status === "starting" ? "" : "dead";
  }
</script>

<!-- Bare: the header row goes to the shells, and the title sits over the
     list, where the tools are anyway. -->
<Pane id="terminal" title="Terminal" bare>
  <div class="wrap">
    <!-- The list comes before the shells, drawn on their right: a shell
         keeps Tab, so the panel's own controls are reached first. -->
    <nav class="list" style:width="{layout.terminalList}px" aria-label="Terminals">
      <div class="top" data-tauri-drag-region>
        <span class="title" class:on={focused} data-tauri-drag-region>Terminal</span>
        <button
          class="tool"
          onclick={another}
          disabled={workspace.active === null}
          aria-label="New terminal"
          title="New terminal"
          data-testid="new-terminal">+</button
        >
        <button
          class="tool"
          onclick={beside}
          disabled={current === null}
          aria-label="Split the current shell"
          title="Split"
          data-testid="split-terminal">⫿</button
        >
        <button class="tool" onclick={hideTerminal} data-testid="hide-terminal">hide</button>
      </div>

      <!-- One row per shell, grouped: the rows under the first of a group are
           the shells beside it. The rows are one stop, walked with the
           arrows. A click, Enter or Space on a row goes to its shell, and
           Delete closes the shell once the arrows have walked the rows. -->
      <div class="rows" role="listbox" aria-label="Shells" bind:this={rows}>
      {#each groups as group (group[0].group)}
        <div class="group" class:on={group[0].group === shown} role="group" data-testid="terminal-group">
          {#each group as shell, i (shell.key)}
            <div class="row" class:beside={i > 0} class:on={shell.key === terminals.active}>
              <button
                class="name"
                role="option"
                onpointerdown={(e) => e.preventDefault()}
                onclick={() => choose(shell.key)}
                onkeydown={(e) => onRowKeydown(e, shell.key)}
                onfocusout={onRowFocusout}
                aria-selected={shell.key === terminals.active}
                aria-current={shell.key === terminals.active ? "true" : undefined}
                data-testid="terminal-row"
              >
                <span class="dot {dot(shell)}"></span>
                <span class="label">{label(shell)}</span>
              </button>
              <button
                class="icon"
                onclick={() => split(shell.key)}
                aria-label="Split {label(shell)}"
                title="Split"
                data-testid="split-row">⫿</button
              >
              <button
                class="icon"
                onclick={() => close(shell.key)}
                aria-label="Close {label(shell)}"
                title="Close"
                data-testid="close-terminal">×</button
              >
            </div>
          {/each}
        </div>
      {/each}
      </div>
    </nav>

    <Splitter
      label="Resize the terminal list"
      onDelta={resizeList}
      onReset={resetList}
      onCommit={saveLayout}
    />

    <div class="shells" bind:clientWidth={shellsWidth}>
      <!-- Every shell stays mounted. The shown group's sit side by side in
           flow; the rest are parked underneath, hidden, at their old size. -->
      {#each terminals.all as shell (shell.key)}
        {#if afterFirst(shell)}
          <Splitter
            label="Resize {label(shell)}"
            onDelta={(dx) => resizeSplit(shell.key, dx, shellsWidth)}
            onReset={() => equalize(shell.key)}
          />
        {/if}
        <div
          class="slot"
          class:on={shell.group === shown}
          class:focused={shell.key === terminals.active && groupOf(shell.key).length > 1}
          style:flex="{share(shell)} 1 0px"
          role="presentation"
          onpointerdown={() => select(shell.key)}
          data-testid="terminal-slot"
        >
          <TerminalView
            id={shell.key}
            ptyId={shell.ptyId}
            active={shell.group === shown}
            shown={terminalVisible()}
            focused={layout.focus === "terminal" && shell.key === terminals.active}
            start={(cols, rows, onOutput) => launch(shell.key, cols, rows, onOutput)}
            fontSize={sizeOf(shell.key)}
          />
        </div>
      {/each}

      {#if workspace.active === null}
        <div class="overlay" data-testid="terminal-status">
          <p class="message">Open a project to start a shell in.</p>
        </div>
      {:else if current === null}
        <div class="overlay" data-testid="terminal-status">
          <p class="message">No shell open in this project.</p>
          <button onclick={another} data-testid="start-terminal">New terminal</button>
        </div>
      {:else if current.status !== "running"}
        <div class="overlay" data-testid="terminal-status">
          <p class="message">{statusMessage(current)}</p>
          {#if current.status !== "starting"}
            <button onclick={another} data-testid="start-terminal">New terminal</button>
          {/if}
        </div>
      {/if}
    </div>

  </div>
</Pane>

<style>
  .top {
    display: flex;
    align-items: baseline;
    gap: 2px;
    padding: 9px var(--pane-pad) 8px;
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-family: var(--chrome);
    font-size: var(--title-size);
    font-weight: var(--title-weight);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--title-color);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title.on {
    color: var(--accent);
  }

  .tool {
    flex: none;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 0 5px;
  }

  .tool:hover:not(:disabled) {
    color: var(--accent);
  }

  .tool:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row-reverse;
    background: var(--surface);
  }

  .shells {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: stretch;
    padding: var(--term-air);
  }

  .slot {
    position: relative;
    min-width: 0;
  }

  /* Parked: out of flow, hidden, and still the size it had. */
  .slot:not(.on) {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }

  /* Only among siblings does it matter which one has the keyboard. */
  .slot.focused {
    box-shadow: inset 0 2px 0 var(--accent);
  }

  .list {
    flex: none;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding-bottom: 6px;
    border-left: 1px solid var(--rule);
  }

  .top + .rows > .group:first-child {
    margin-top: 6px;
  }

  .group {
    padding: 2px 0;
  }

  .group.on {
    background: var(--surface-2);
  }

  .row {
    display: flex;
    align-items: center;
  }

  .row.beside {
    padding-left: 14px;
    position: relative;
  }

  .row.beside::before {
    content: "";
    position: absolute;
    left: 14px;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--rule);
  }

  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    text-align: left;
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-2);
    cursor: pointer;
  }

  .row.on .name {
    color: var(--accent);
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .dot.dead {
    background: var(--del);
    border-color: var(--del);
  }

  .icon {
    flex: none;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 13px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
    opacity: 0;
  }

  .icon:last-child {
    padding-right: 8px;
  }

  .row:hover .icon,
  .row.on .icon,
  .icon:focus-visible {
    opacity: 1;
  }

  .icon:hover {
    color: var(--accent);
  }

  .overlay {
    position: absolute;
    inset: auto 0 0 0;
    z-index: 1;
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px var(--pane-pad);
    border-top: 1px solid var(--rule);
    background: var(--surface-2);
  }

  .message {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-2);
    max-width: 64ch;
  }

  .overlay button {
    margin-left: auto;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }
</style>

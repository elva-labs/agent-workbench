<script lang="ts">
  import { untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import {
    DEFAULT,
    MIN,
    applyLayout,
    hideTerminal,
    layout,
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

    <Splitter
      label="Resize the terminal list"
      onDelta={resizeList}
      onReset={resetList}
      onCommit={saveLayout}
    />

    <nav class="list" style:width="{layout.terminalList}px" aria-label="Terminals">
      <div class="top">
        <span class="title" class:on={focused}>Terminal</span>
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
           the shells beside it. -->
      {#each groups as group (group[0].group)}
        <div class="group" class:on={group[0].group === shown} data-testid="terminal-group">
          {#each group as shell, i (shell.key)}
            <div class="row" class:beside={i > 0} class:on={shell.key === terminals.active}>
              <button
                class="name"
                onclick={() => select(shell.key)}
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
    </nav>
  </div>
</Pane>

<style>
  .top {
    display: flex;
    align-items: baseline;
    gap: 2px;
    padding: 9px var(--pane-pad) 8px;
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
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
    background: none;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
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
    background: var(--surface);
  }

  .shells {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: stretch;
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

  .top + .group {
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
    padding: 4px var(--pane-pad);
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11.5px;
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
    width: 6px;
    height: 6px;
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
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 12px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }
</style>

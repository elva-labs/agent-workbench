<script lang="ts">
  import { untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import { hideTerminal, terminalVisible } from "$lib/layout.svelte";
  import {
    activeShell,
    close,
    create,
    forProject,
    label,
    launch,
    select,
    statusMessage,
    terminals,
  } from "$lib/terminals.svelte";
  import { workspace } from "$lib/workspace.svelte";

  let current = $derived(activeShell());
  let own = $derived(workspace.active === null ? [] : forProject(workspace.active));

  // Asking for the panel is asking for a shell: it opens with one when the
  // project has none. Only on showing it or on changing project, never as a
  // reaction to a tab going, or a shell that exits at once would be a loop.
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
</script>

<Pane id="terminal" title="Terminal">
  {#snippet head()}
    <div class="tabs" role="tablist" aria-label="Terminals">
      {#each own as shell (shell.key)}
        <div class="tab" class:on={terminals.active === shell.key}>
          <button
            role="tab"
            aria-selected={terminals.active === shell.key}
            onclick={() => select(shell.key)}
            data-testid="terminal-tab">{label(shell)}</button
          >
          <button
            class="icon"
            onclick={() => close(shell.key)}
            aria-label="Close {label(shell)}"
            data-testid="close-terminal">×</button
          >
        </div>
      {/each}
      <button
        class="icon add"
        onclick={another}
        disabled={workspace.active === null}
        aria-label="New terminal"
        data-testid="new-terminal">+</button
      >
    </div>
    <button class="tool" onclick={hideTerminal} data-testid="hide-terminal">hide</button>
  {/snippet}

  <div class="wrap">
    <!-- Every shell stays mounted, the active one visible, as in the agent pane. -->
    {#each terminals.all as shell (shell.key)}
      <TerminalView
        id={shell.key}
        ptyId={shell.ptyId}
        active={shell.key === terminals.active}
        shown={terminalVisible()}
        start={(cols, rows, onOutput) => launch(shell.key, cols, rows, onOutput)}
      />
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
</Pane>

<style>
  .tabs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    flex: none;
  }

  .tab button,
  .tool,
  .icon {
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tab button[role="tab"] {
    padding-right: 2px;
  }

  .tab.on button[role="tab"] {
    color: var(--ink);
  }

  .tab .icon {
    padding-left: 2px;
    opacity: 0;
  }

  .tab:hover .icon,
  .tab.on .icon,
  .tab .icon:focus-visible {
    opacity: 1;
  }

  .icon:hover,
  .tool:hover,
  .tab button:hover {
    color: var(--accent);
  }

  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .tool {
    flex: none;
  }

  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--surface);
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

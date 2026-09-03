<script lang="ts">
  import { onMount, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import { core } from "$lib/core";
  import { agent, applyDetect, detectFailed, unavailableReason } from "$lib/agent.svelte";
  import { agentVisible } from "$lib/layout.svelte";
  import {
    activeSession,
    create,
    launch,
    sessions,
    shouldAutoStart,
    statusLabel,
    statusMessage,
  } from "$lib/sessions.svelte";
  import { workspace } from "$lib/workspace.svelte";

  let current = $derived(activeSession());
  let blocked = $derived(unavailableReason());

  onMount(detect);

  /** Asks the machine whether there is an agent to run. Asked once on open,
      and again on request: installing claude should not need a restart. */
  function detect() {
    core()
      .detect("claude-code")
      .then((report) =>
        applyDetect(report, Boolean(window.__WORKBENCH_CORE__ || window.__TAURI_INTERNALS__)),
      )
      .catch((error) => detectFailed(String(error)));
  }

  // Opening a project starts a session in it when it has none. A workbench
  // whose purpose is running an agent should not open onto a button. What it
  // must never do is restart one that stopped: that is the respawn loop the
  // exit policy forbids.
  $effect(() => {
    const project = workspace.active;
    const availability = agent.availability;
    untrack(() => {
      if (availability === "ready" && project !== null && shouldAutoStart(project)) {
        create(project);
      }
    });
  });

  function startAnother() {
    if (workspace.active !== null) create(workspace.active);
  }
</script>

<Pane id="agent" title="Agent · Claude Code" meta={statusLabel(current)}>
  <div class="wrap">
    <!-- Every session stays mounted. Only the active one is visible, so its
         PTY keeps its size and coming back to it costs no reflow. -->
    {#each sessions.all as session (session.key)}
      <TerminalView
        id={session.key}
        ptyId={session.ptyId}
        active={session.key === sessions.active}
        shown={agentVisible()}
        start={(cols, rows, onOutput) => launch(session.key, cols, rows, onOutput)}
      />
    {/each}

    {#if blocked !== null}
      <div class="overlay" data-testid="agent-status">
        <p class="message">{blocked}</p>
        {#if agent.availability === "missing"}
          <button onclick={detect} data-testid="retry-detect">Look again</button>
        {/if}
      </div>
    {:else if workspace.active === null}
      <div class="overlay" data-testid="agent-status">
        <p class="message">Open a project to start a session.</p>
      </div>
    {:else if current === null}
      <div class="overlay" data-testid="agent-status">
        <p class="message">No session open in this project.</p>
        <button onclick={startAnother} data-testid="start-agent">New session</button>
      </div>
    {:else if current.status !== "running"}
      <div class="overlay" data-testid="agent-status">
        <p class="message">{statusMessage(current)}</p>
        {#if current.status !== "starting"}
          <button onclick={startAnother} data-testid="start-agent">New session</button>
        {/if}
      </div>
    {/if}
  </div>
</Pane>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--surface);
  }

  /* Sits over the terminal rather than replacing it: the buffer of a stopped
     session is still worth reading. */
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

  button {
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

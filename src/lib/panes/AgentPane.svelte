<script lang="ts">
  import HooksNotice from "$lib/components/HooksNotice.svelte";
  import { onMount, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import { core } from "$lib/core";
  import {
    AGENTS,
    agent,
    agentLabel,
    applyDetect,
    detectFailed,
    unavailableReason,
  } from "$lib/agent.svelte";
  import { agentVisible, layout } from "$lib/layout.svelte";
  import {
    activeSession,
    create,
    launch,
    rang,
    sessions,
    statusLabel,
    statusMessage,
    titled,
  } from "$lib/sessions.svelte";
  import { referenced } from "$lib/show.svelte";
  import { workspace } from "$lib/workspace.svelte";

  let current = $derived(activeSession());
  let blocked = $derived(unavailableReason());

  onMount(detect);

  /** Asks the machine which agents there are to run. Asked once on open,
      and again on request: installing one should not need a restart. */
  function detect() {
    const hasCore = Boolean(window.__WORKBENCH_CORE__ || window.__TAURI_INTERNALS__);
    for (const id of AGENTS) {
      core()
        .detect(id)
        .then((report) => applyDetect(report, hasCore))
        .catch((error) => detectFailed(String(error)));
    }
  }

  let title = $derived(current === null ? "Agent" : `Agent · ${agentLabel(current.agent)}`);


  function startAnother() {
    if (workspace.active !== null) create(workspace.active);
  }
</script>

<Pane id="agent" {title} meta={statusLabel(current)}>
  <div class="wrap">
    <HooksNotice />
    <!-- Every session stays mounted. Only the active one is visible, so its
         PTY keeps its size and coming back to it costs no reflow. -->
    {#each sessions.all as session (session.key)}
      <TerminalView
        id={session.key}
        ptyId={session.ptyId}
        active={session.key === sessions.active}
        shown={agentVisible()}
        focused={layout.focus === "agent"}
        start={(cols, rows, onOutput) => launch(session.key, cols, rows, onOutput)}
        onTitle={session.agent === "claude-code" ? (raw) => titled(session.key, raw) : undefined}
        onAttention={() => rang(session.key)}
        onFileRef={(path, line) => referenced(session.key, path, line)}
        newlineOnShiftEnter
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
        <p class="message">
          No session open. Resume a past one from the list, or start a new one.
        </p>
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

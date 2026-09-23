<script lang="ts">
  import HooksNotice from "$lib/components/HooksNotice.svelte";
  import { onMount, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import { core, type AgentId } from "$lib/core";
  import {
    AGENTS,
    agent,
    agentLabel,
    applyDetect,
    detectFailed,
    installed,
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
    wake,
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

  // A session that was open when the app quit starts once it is the one
  // this pane shows.
  $effect(() => {
    if (current?.status === "dormant") wake(current.key);
  });

  /** Whether the new-session button has opened into the choice of agent. */
  let choosing = $state(false);

  // The choice belongs to the bar it opened in: another session coming up
  // closes it.
  $effect(() => {
    void current?.key;
    choosing = false;
  });

  function startAnother() {
    if (installed().length > 1) choosing = true;
    else if (workspace.active !== null) create(workspace.active);
  }

  function startWith(id: AgentId) {
    choosing = false;
    if (workspace.active !== null) create(workspace.active, null, id);
  }

  /** Escape backs out of the choice while one of its buttons has focus.
      From the terminal it is the agent's. */
  function onChoiceKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    choosing = false;
  }
</script>

<!-- The way to a session from here. With several agents installed the
     button opens, in place, into one button each; with one there is
     nothing to choose and it starts. -->
{#snippet starters()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="starters" onkeydown={onChoiceKey}>
    {#if choosing && installed().length > 1}
      {#each installed() as id (id)}
        <button onclick={() => startWith(id)} data-testid={`start-agent-${id}`} data-agent={id}
          >{agentLabel(id)}</button
        >
      {/each}
      <button
        class="cancel"
        onclick={() => (choosing = false)}
        aria-label="Cancel"
        data-testid="start-agent-cancel">×</button
      >
    {:else}
      <button onclick={startAnother} data-testid="start-agent">New session</button>
    {/if}
  </div>
{/snippet}

<Pane id="agent" {title} meta={statusLabel(current)}>
  <div class="wrap">
    <HooksNotice />
    <!-- Every session that has started stays mounted. Only the active one
         is visible, so its PTY keeps its size and coming back to it costs
         no reflow. -->
    {#each sessions.all as session (session.key)}
      {#if session.status !== "dormant"}
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
      {/if}
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
        <p class="message">No session open. Resume a past one from the list, or start a new one.</p>
        {@render starters()}
      </div>
    {:else if current.status !== "running"}
      <div class="overlay" data-testid="agent-status">
        <p class="message">{statusMessage(current)}</p>
        {#if current.status !== "starting"}
          {@render starters()}
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
    padding: var(--term-air);
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

  .overlay > button,
  .starters {
    margin-left: auto;
  }

  .starters {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  button {
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

  .cancel {
    padding: 4px 6px;
    border-color: transparent;
    background: none;
    color: var(--ink-2);
  }
</style>

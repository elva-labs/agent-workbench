<script lang="ts">
  import { shown } from "$lib/thread";
  import HooksNotice from "$lib/components/HooksNotice.svelte";
  import WorkflowTagButton from "$lib/components/WorkflowTagButton.svelte";
  import RunChip from "$lib/components/RunChip.svelte";
  import { letters } from "$lib/giveWay";
  import { onMount, tick, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import ConversationView from "$lib/components/conversation/ConversationView.svelte";
  import Icon from "$lib/components/conversation/Icon.svelte";
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
  import { agentVisible, layout, overlayHoldsKeyboard } from "$lib/layout.svelte";
  import {
    activeSession,
    create,
    defaultAgent,
    label,
    otherWay,
    launch,
    belled,
    sessions,
    statusLabel,
    resumeWithout,
    dismissKept,
    statusMessage,
    titled,
    wake,
  } from "$lib/sessions.svelte";
  import { referenced } from "$lib/show.svelte";
  import type { SessionKind } from "$lib/sessionKind.svelte";
  import { handleOf, launch as launchIntegrated, linkFor, unspoken } from "$lib/integrated.svelte";
  import { accountOf } from "$lib/accounts.svelte";
  import { conductor, dismissRefusal, runStanding, workflowTag } from "$lib/conductor.svelte";
  import { projectLabel, workspace } from "$lib/workspace.svelte";
  import { touch } from "$lib/projects.svelte";
  import { sizeOf } from "$lib/zoom.svelte";

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

  let integrated = $derived(current?.kind === "integrated");

  // An integrated session's header names it, its project and its branch.
  let title = $derived(
    current === null
      ? "Agent"
      : integrated
        ? shown(label(current))
        : `Agent · ${agentLabel(current.agent)}`,
  );

  /** What the header says of the session: for an integrated one waiting
      on the user before it can run, what it waits for. */
  let meta = $derived.by(() => {
    if (current !== null && current.kind === "integrated") {
      const link = linkFor(current.key);
      if (link.untrusted) return "asks to trust the folder";
      if (link.conversation.notLoggedIn) return "not signed in";
      // What the session is doing, from its own events: what it waits on
      // when it waits on the user, else working or idle.
      if (current.status === "running") {
        const open = link.conversation.open[0];
        if (open !== undefined) return open.asked.type === "questionAsked" ? "asks you" : "waits for permission";
        return link.conversation.working ? "working" : "idle";
      }
    }
    return statusLabel(current);
  });

  let branch = $state<string | null>(null);
  $effect(() => {
    if (current === null || current.kind !== "integrated") return;
    const dir = current.worktree ?? current.startIn ?? current.project;
    // Read again when a turn ends, since the agent may have switched it.
    void current.working;
    let stale = false;
    core()
      .projectInfo(dir)
      .then((info) => {
        if (!stale) branch = info.branch ?? null;
      })
      .catch(() => {
        if (!stale) branch = null;
      });
    return () => {
      stale = true;
    };
  });

  /** The workflow the session on screen is part of, and its place in it. */
  let tag = $derived(current === null ? null : workflowTag(current));
  /** Where the run stands, for a session that follows a workflow: the chip
      takes the tag's place. Before anything is said in a conversation its
      composer says the workflow, which can still be chosen there, and the
      chip comes once the first message is sent. */
  let run = $derived(current === null || unspoken(current) ? null : runStanding(current));
  let refusal = $derived(current === null ? null : (conductor.refusals[current.key] ?? null));

  // A session that was open when the app quit starts once it is the one
  // this pane shows.
  $effect(() => {
    if (current?.status === "dormant") wake(current.key);
  });

  // An integrated session starts as soon as its row is starting, as a
  // terminal session starts when its terminal mounts.
  $effect(() => {
    for (const session of sessions.all) {
      if (session.kind !== "integrated" || session.status !== "starting") continue;
      const key = session.key;
      untrack(() => {
        if (handleOf(key) === null) void launchIntegrated(key);
      });
    }
  });

  /** Whether the new-session button has opened into the choice of agent. */
  let choosing = $state(false);

  // The choice belongs to the bar it opened in: another session coming up
  // closes it.
  $effect(() => {
    void current?.key;
    choosing = false;
  });

  let wrap = $state<HTMLDivElement | null>(null);

  // A project with no session has no terminal to take the keyboard, so a
  // request for the agent pane gives it to the New session button, unless it
  // is already on a control inside this pane. It is taken from the page body,
  // from a terminal that is out of sight and from a control in another pane.
  $effect(() => {
    layout.focusRequest;
    untrack(() => {
      if (layout.focus !== "agent" || !agentVisible() || wrap === null) return;
      if (current !== null || blocked !== null || workspace.active === null) return;
      if (overlayHoldsKeyboard()) return;
      const owner = document.activeElement;
      const pane = wrap.closest("section");
      if (
        owner !== null &&
        pane?.contains(owner) &&
        owner !== document.body &&
        owner.closest("[data-terminal]") === null
      )
        return;
      void tick().then(() => {
        (owner as HTMLElement | null)?.blur?.();
        wrap?.querySelector<HTMLElement>("[data-testid='start-agent']")?.focus();
      });
    });
  });

  /** Starting a session uses its project. */
  function startAnother() {
    if (installed().length > 1) choosing = true;
    else if (workspace.active !== null) {
      touch(workspace.active);
      create(workspace.active);
    }
  }

  function startWith(id: AgentId) {
    choosing = false;
    if (workspace.active === null) return;
    touch(workspace.active);
    create(workspace.active, null, id);
  }

  /** The agent a new session here starts with, and the other way it can
      run, when it has one. */
  let firstAgent = $derived(workspace.active === null ? null : defaultAgent(workspace.active));
  let other = $derived(workspace.active === null ? null : otherWay(workspace.active));

  /** One session started the other way from New session, alone. */
  function startOther(kind: SessionKind) {
    choosing = false;
    const project = workspace.active;
    if (project === null || firstAgent === null) return;
    touch(project);
    create(project, null, firstAgent, null, null, null, accountOf(project), null, kind);
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
      {#if other !== null && firstAgent !== null}
        <button class="quiet" onclick={() => startOther(other!)} data-testid="start-other"
          >{other === "integrated" ? "New integrated session" : "New session in a terminal"}</button
        >
      {/if}
      <button onclick={startAnother} data-testid="start-agent">New session</button>
    {/if}
  </div>
{/snippet}

{#snippet head()}
  {#if run !== null && tag !== null}
    <RunChip {run} rules={tag.rules} />
  {:else if tag !== null && current?.workflow === null}
    <WorkflowTagButton {tag} />
  {/if}
  {#if current !== null && integrated}
    <span class="crumb" title={current.project} data-testid="conversation-project"
      ><Icon name="folder" size={13} /><span class="crumb-text" use:letters={projectLabel(current.project)}
        >{projectLabel(current.project)}</span
      ></span
    >
    {#if branch !== null}
      <span class="crumb" data-testid="conversation-branch"
        ><Icon name="branch" size={13} /><span class="crumb-text" use:letters={branch}>{branch}</span></span
      >
    {/if}
  {/if}
{/snippet}

<Pane id="agent" {title} {meta} head={tag !== null || integrated ? head : undefined}>
  <div class="wrap" bind:this={wrap}>
    {#if refusal !== null && current !== null}
      <!-- What the workflow refused the agent, said to the user too. -->
      <p class="refused" data-testid="workflow-refused">
        <span class="refused-lead">Start refused</span>
        <span class="refused-text">{refusal}</span>
        <button
          class="refused-close"
          onclick={() => dismissRefusal(current!.key)}
          aria-label="Dismiss"
          data-testid="workflow-refused-dismiss">×</button
        >
      </p>
    {:else if current !== null && current.keptFromStart !== null}
      <!-- What Codex kept from the session's start, which this start
           could not change. -->
      <p class="refused" data-testid="session-kept">
        <span class="refused-lead">Resumed as it began</span>
        <span class="refused-text">{current.keptFromStart}</span>
        <button
          class="refused-close"
          onclick={() => dismissKept(current!.key)}
          aria-label="Dismiss"
          data-testid="session-kept-dismiss">×</button
        >
      </p>
    {/if}
    <HooksNotice />
    <!-- Every session that has started stays mounted. Only the active one
         is visible, so its PTY keeps its size and coming back to it costs
         no reflow. -->
    {#each sessions.all as session (session.key)}
      {#if session.status !== "dormant" && session.kind === "terminal"}
        <TerminalView
          id={session.key}
          ptyId={session.ptyId}
          active={session.key === sessions.active}
          shown={agentVisible()}
          focused={layout.focus === "agent"}
          start={(cols, rows, onOutput) => launch(session.key, cols, rows, onOutput)}
          onTitle={session.agent === "claude-code" ? (raw) => titled(session.key, raw) : undefined}
          onAttention={() => belled(session.key)}
          onFileRef={(path, line) => referenced(session.key, path, line)}
          fontSize={sizeOf(session.key, session.id)}
          newlineOnShiftEnter
        />
      {:else if session.status !== "dormant"}
        <ConversationView {session} active={session.key === sessions.active} />
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
    {:else if current.kind === "integrated"}
      <!-- The conversation says itself how it stands. -->
    {:else if current.status !== "running"}
      <div class="overlay" data-testid="agent-status">
        <p class="message">{statusMessage(current)}</p>
        {#if current.workflowLost !== null}
          <!-- The workflow this session followed is gone with its copy:
               going on without one is the user's to say. -->
          <button class="without" onclick={() => resumeWithout(current!.key)} data-testid="resume-without-workflow"
            >Resume without a workflow</button
          >
        {/if}
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
    background: var(--clear-surface);
  }

  /* The session's project and branch give way before the workflow tag
     beside them, cut short and then gone with their icon at a letter or
     two. */
  .crumb {
    flex: 0 1000000 auto;
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-family: var(--chrome);
    font-size: var(--meta-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .crumb + .crumb {
    margin-left: 6px;
  }

  .crumb-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .crumb:has(:global(.crumb-text.cut)) {
    visibility: hidden;
  }

  /* Gone before a run's chip is cut short, so once it is they leave no
     gap beside it either. */
  :global(.head:has([data-short])) .crumb {
    display: none;
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

  /* One line over the top of the terminal, cut short. */
  .refused {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 1;
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0;
    padding: 6px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-2);
  }

  /* Where the cards let a background through, the second surface is a
     fill let through, laid over the card's paint so this still covers
     what is under it. */
  :global(:root[data-cards]) :is(.overlay, .refused) {
    background: linear-gradient(var(--surface-2), var(--surface-2)), var(--paint-surface);
  }

  .refused-lead {
    flex: none;
    font-size: var(--meta-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--accent);
  }
  .refused-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The whole of it while the pointer or the keyboard is on it. */
  .refused:hover .refused-text,
  .refused:focus-within .refused-text {
    white-space: normal;
  }
  .refused-close {
    border: 0;
    background: none;
    color: var(--ink-3);
    cursor: pointer;
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

  button.quiet {
    border-color: transparent;
    background: none;
    color: var(--ink-2);
  }

  button.quiet:hover {
    color: var(--ink);
  }

  .cancel {
    padding: 4px 6px;
    border-color: transparent;
    background: none;
    color: var(--ink-2);
  }
</style>

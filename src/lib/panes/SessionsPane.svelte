<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import { AGENTS, agentLabel, agentTag, installed, isReady } from "$lib/agent.svelte";
  import type { AgentId } from "$lib/core";
  import { shorten } from "$lib/paths";
  import {
    ago,
    byKey,
    close as closeSession,
    create,
    defaultAgent,
    forProject,
    historyFor,
    historyLabel,
    isLive,
    label,
    loadHistory,
    outsideFor,
    select,
    sessions,
    statusLabel,
    disown,
  } from "$lib/sessions.svelte";
  import { activate, close as closeProject, openPath, pick, workspace } from "$lib/workspace.svelte";
  import { hostOf, openRemote } from "$lib/remote.svelte";
  import { focusPane, layout } from "$lib/layout.svelte";

  let notOpen = $derived(workspace.recent.filter((path) => !isOpen(path)));

  /** Folds of sessions from outside the app that are open, by project and agent. */
  let unfolded = $state<Record<string, boolean>>({});

  /** With more than one agent to run, every row says which it is, and the
      new-session row offers the choice. With one, nothing changes. */
  let several = $derived(installed().length > 1);

  /** The project whose new-session row is open on the choice of agent. */
  let choosing = $state<string | null>(null);

  /** New session: with one agent it starts; with several the row opens
      into the choice, the cursor on the one the project used last. */
  function offer(path: string) {
    if (!several) {
      start(path, defaultAgent(path));
      return;
    }
    choosing = path;
    cursor = `pick:${path}:${defaultAgent(path)}`;
  }

  function startWith(path: string, agent: AgentId) {
    choosing = null;
    start(path, agent);
  }

  /** Closes the choice, the cursor back on the row it opened from. */
  function dismiss(): boolean {
    if (choosing === null) return false;
    cursor = `new:${choosing}`;
    choosing = null;
    return true;
  }

  /**
   * Every row the keyboard can land on, in the order the pane shows them.
   * The pane is one tab stop with a cursor inside it, like the file tree:
   * Up and Down move the cursor, Enter does what a click on the row does.
   */
  interface Row {
    id: string;
    run: () => void;
  }

  let rows = $derived.by(() => {
    const out: Row[] = [
      { id: "open", run: pick },
      { id: "remote", run: openRemote },
    ];
    for (const project of workspace.open) {
      const path = project.path;
      out.push({ id: `project:${path}`, run: () => activate(path) });
      for (const session of forProject(path)) {
        out.push({ id: `session:${session.key}`, run: () => choose(session.key) });
      }
      if (workspace.active !== path) continue;
      for (const transcript of historyFor(path)) {
        out.push({
          id: `past:${transcript.id}`,
          run: () => resume(path, transcript.id, transcript.agent),
        });
      }
      if (isReady()) {
        if (several && choosing === path) {
          for (const agent of installed()) {
            out.push({ id: `pick:${path}:${agent}`, run: () => startWith(path, agent) });
          }
        } else {
          out.push({ id: `new:${path}`, run: () => offer(path) });
        }
      }
      for (const agent of AGENTS) {
        if (outsideFor(path, agent).length === 0) continue;
        const fold = `${path}:${agent}`;
        out.push({ id: `fold:${fold}`, run: () => (unfolded[fold] = !unfolded[fold]) });
        if (unfolded[fold]) {
          for (const transcript of outsideFor(path, agent)) {
            out.push({
              id: `outside:${transcript.id}`,
              run: () => resume(path, transcript.id, transcript.agent),
            });
          }
        }
      }
    }
    for (const path of notOpen) out.push({ id: `recent:${path}`, run: () => openPath(path) });
    return out;
  });

  let cursor = $state<string | null>(null);
  let nav: HTMLDivElement;

  /** The cursor, or where it starts: the session you are in, else the top. */
  let current = $derived.by(() => {
    if (cursor !== null && rows.some((row) => row.id === cursor)) return cursor;
    const active = sessions.active === null ? null : `session:${sessions.active}`;
    if (active !== null && rows.some((row) => row.id === active)) return active;
    const project = workspace.active === null ? null : `project:${workspace.active}`;
    if (project !== null && rows.some((row) => row.id === project)) return project;
    return rows[0]?.id ?? null;
  });

  /** What the button on the row under the cursor would do: × on a project
      or a live session, archive on a past one. */
  function remove(id: string) {
    if (id.startsWith("project:")) closeProject(id.slice("project:".length));
    else if (id.startsWith("session:")) closeSession(id.slice("session:".length));
    else if (id.startsWith("past:") && workspace.active !== null) {
      disown(workspace.active, id.slice("past:".length));
    }
  }

  // Focusing the pane by key puts the keyboard here, so the arrows work at
  // once, and starts the cursor over from the session you are in rather than
  // from whatever a click left it on. A click inside already has the keyboard.
  $effect(() => {
    layout.focusRequest;
    if (layout.focus === "sessions" && nav && !nav.contains(document.activeElement)) {
      cursor = null;
      nav.focus();
    }
  });

  /** Picking a session is wanting to type into it, and to see its project:
      one under another project brings that project forward first. */
  function choose(key: string) {
    const session = byKey(key);
    if (session === null) return;
    if (session.project !== workspace.active) activate(session.project);
    select(key);
    focusPane("agent");
  }

  function resume(path: string, id: string, agent: AgentId) {
    create(path, id, agent);
    focusPane("agent");
  }

  function start(path: string, agent: AgentId) {
    create(path, null, agent);
    focusPane("agent");
  }

  function moveTo(index: number) {
    if (rows.length === 0) return;
    const at = Math.max(0, Math.min(index, rows.length - 1));
    cursor = rows[at].id;
    nav.querySelector(`[data-row="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(e: KeyboardEvent) {
    const at = rows.findIndex((row) => row.id === current);
    switch (e.key) {
      case "ArrowDown":
        moveTo(at + 1);
        break;
      case "ArrowUp":
        moveTo(at - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "Escape":
        // Closes an open choice of agent, and goes no further: Escape
        // elsewhere is the agent's.
        if (!dismiss()) return;
        e.stopPropagation();
        break;
      case "Enter":
      case " ":
        if (at === -1) return;
        rows[at].run();
        break;
      case "Delete":
      case "Backspace":
        if (current === null) return;
        remove(current);
        break;
      default:
        return;
    }
    // The arrows put the keyboard back on the pane, so Enter is the row
    // under the cursor and not a button a click left focused.
    nav.focus();
    e.preventDefault();
  }

  /** A click puts the cursor on what was clicked, so the keyboard carries on
      from there. */
  function onPointerdown(e: PointerEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (row?.dataset.row !== undefined) cursor = row.dataset.row;
  }

  // Read once per project as it opens. The index is history on disk, so it
  // changes when Claude Code writes, not when this window does.
  $effect(() => {
    for (const project of workspace.open) {
      if (sessions.history[project.path] === undefined) loadHistory(project.path);
    }
  });

  function isOpen(path: string) {
    return workspace.open.some((project) => project.path === path);
  }

</script>

<Pane id="sessions" title="Projects &amp; sessions" meta="">
  {#if workspace.error}
    <p class="error" data-testid="project-error">{workspace.error}</p>
  {/if}

  {#if workspace.open.length === 0}
    <div class="empty" data-testid="no-project">
      <p>Open a folder to work in. A session starts there, and the changes pane watches it.</p>
    </div>
  {/if}

  <!-- One tab stop with a cursor inside, the tree's pattern. The rows stay
       buttons for the mouse; the keyboard goes through here. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="nav"
    tabindex="0"
    aria-label="Projects and sessions"
    bind:this={nav}
    onkeydown={onKeydown}
    onpointerdown={onPointerdown}
    data-testid="sessions-nav"
  >
  <!-- The way in, on the same cursor as the rows below. -->
  <div class="head">
    <button
      class:cursor={current === "open"}
      tabindex="-1"
      onclick={pick}
      disabled={workspace.opening}
      data-row="open"
      data-testid="open-project"
    >
      Open project
    </button>
    <button
      class="remote"
      class:cursor={current === "remote"}
      tabindex="-1"
      onclick={openRemote}
      disabled={workspace.opening}
      data-row="remote"
      data-testid="open-remote"
      title="A project on another machine, over ssh"
    >
      Remote…
    </button>
  </div>
  <div class="tree">
    {#each workspace.open as project (project.path)}
      {@const own = forProject(project.path)}
      <div
        class="project"
        class:on={workspace.active === project.path}
        class:cursor={current === `project:${project.path}`}
        data-row="project:{project.path}"
      >
        <button class="row project-row" tabindex="-1" onclick={() => activate(project.path)} title={project.path}>
          <span class="name">{project.name}</span>
          {#if hostOf(project.path) !== null}<span class="host" data-testid="project-host">{hostOf(project.path)}</span>{/if}
          {#if !project.isGit}<span class="flag" title="Not a git repository">no git</span>{/if}
        </button>
        <button
          class="icon"
          tabindex="-1"
          onclick={() => closeProject(project.path)}
          aria-label="Close {project.name}"
          data-testid="close-project">×</button
        >
      </div>

      {#each own as session (session.key)}
        <div
          class="session"
          class:on={sessions.active === session.key}
          class:cursor={current === `session:${session.key}`}
          data-row="session:{session.key}"
        >
          <button class="row" tabindex="-1" onclick={() => choose(session.key)} data-testid="session-row">
            <span
              class="dot"
              class:live={isLive(session)}
              class:working={session.working}
              class:unread={session.unread}
              class:permission={session.needs === "permission"}
              title={statusLabel(session)}
            ></span>
            <span class="label" class:unread={session.unread}>{label(session)}</span>
            {#if several}<span class="tag" data-testid="agent-tag">{agentTag(session.agent)}</span>{/if}
            <!-- The dot says what the agent is doing; the words are for a
                 screen reader and for anything reading the row's text. -->
            <span class="state told">{statusLabel(session)}</span>
          </button>
          <!-- Over the row's end rather than beside it, so a name is never
               squeezed to make room for it. -->
          <span class="actions">
            <button
              class="icon"
              tabindex="-1"
              onclick={() => closeSession(session.key)}
              aria-label="Close {label(session)}"
              title="Stop"
              data-testid="close-session">×</button
            >
          </span>
        </div>
      {/each}

      {#if workspace.active === project.path}
        {#each historyFor(project.path) as transcript (transcript.id)}
          <div
            class="session past-row"
            class:cursor={current === `past:${transcript.id}`}
            data-row="past:{transcript.id}"
          >
            <button
              class="row past"
              tabindex="-1"
              onclick={() => resume(project.path, transcript.id, transcript.agent)}
              disabled={!isReady()}
              title={transcript.title ?? transcript.id}
              data-testid="past-session"
            >
              <span class="dot"></span>
              <span class="label">{historyLabel(transcript)}</span>
              {#if several}<span class="tag">{agentTag(transcript.agent)}</span>{/if}
              <span class="state">{ago(transcript.modified)}</span>
            </button>
            <span class="actions">
              <button
                class="icon"
                tabindex="-1"
                onclick={() => disown(project.path, transcript.id)}
                aria-label="Archive {historyLabel(transcript)}"
                title="File with the sessions to resume"
                data-testid="archive-past">↧</button
              >
            </span>
          </div>
        {/each}

        <!-- With several agents the row opens, in place, into the choice of
             agent; with one there is nothing to choose and it starts. -->
        {#if several && choosing === project.path}
          <div class="choice" role="group" aria-label="Agent for the new session" data-testid="agent-choice">
            <div class="choice-head">
              <span>new session with</span>
              <button class="cancel" tabindex="-1" onclick={dismiss} aria-label="Cancel" data-testid="choice-cancel"
                >esc</button
              >
            </div>
            {#each installed() as id (id)}
              <button
                class="option"
                class:cursor={current === `pick:${project.path}:${id}`}
                tabindex="-1"
                onclick={() => startWith(project.path, id)}
                data-row="pick:{project.path}:{id}"
                data-testid="agent-option"
                data-agent={id}
              >
                <span class="mark">›</span>
                <span class="label">{agentLabel(id)}</span>
                {#if sessions.preferred[project.path] === id}<span class="state">last used</span>{/if}
              </button>
            {/each}
          </div>
        {:else}
          <div
            class="new-row"
            class:cursor={current === `new:${project.path}`}
            data-row="new:{project.path}"
          >
            <button
              class="new"
              tabindex="-1"
              onclick={() => offer(project.path)}
              disabled={!isReady()}
              data-testid="new-session">+ New session</button
            >
          </div>
        {/if}

        <!-- An agent run in a plain terminal here leaves its sessions in the
             same place. They are resumable, so they are here, folded by
             agent, rather than mixed in with what this window started. -->
        {#each AGENTS as agent (agent)}
          {@const outside = outsideFor(project.path, agent)}
          {@const fold = `${project.path}:${agent}`}
          {#if outside.length > 0}
            <button
              class="fold"
              class:cursor={current === `fold:${fold}`}
              tabindex="-1"
              onclick={() => (unfolded[fold] = !unfolded[fold])}
              aria-expanded={Boolean(unfolded[fold])}
              data-row="fold:{fold}"
              data-agent={agent}
              data-testid="outside-fold"
            >
              <span class="chevron" class:open={unfolded[fold]}>▸</span>
              <span class="fold-text"
                >{`${outside.length} ${agentTag(agent)} ${outside.length === 1 ? "session" : "sessions"} to resume`}</span
              >
            </button>
            {#if unfolded[fold]}
              {#each outside as transcript (transcript.id)}
                <button
                  class="row past outside"
                  class:cursor={current === `outside:${transcript.id}`}
                  tabindex="-1"
                  onclick={() => resume(project.path, transcript.id, transcript.agent)}
                  disabled={!isReady()}
                  title={transcript.title ?? transcript.id}
                  data-row="outside:{transcript.id}"
                  data-testid="outside-session"
                >
                  <span class="dot"></span>
                  <span class="label">{historyLabel(transcript)}</span>
                  <span class="state">{ago(transcript.modified)}</span>
                </button>
              {/each}
            {/if}
          {/if}
        {/each}

      {/if}
    {/each}
  </div>

  {#if notOpen.length > 0}
    <p class="section">Recent</p>
    <ul class="recent">
      {#each notOpen as path (path)}
        <li>
          <button
            class:cursor={current === `recent:${path}`}
            tabindex="-1"
            onclick={() => openPath(path)}
            title={path}
            data-row="recent:{path}">{shorten(path)}</button
          >
        </li>
      {/each}
    </ul>
  {/if}
  </div>
</Pane>

<style>
  .head {
    display: flex;
    gap: 6px;
    padding: 8px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  .head button {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 9px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }

  .head button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .head button.cursor {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .nav:focus-within .head .cursor::before {
    content: none;
  }

  /* The way out is the accent; the way elsewhere is quieter. */
  .head button.remote {
    flex: 0 0 auto;
    border-color: var(--rule);
    background: none;
    color: var(--ink-3);
  }

  .head button.remote:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }

  /* Where a project is, when it is not here. */
  .host {
    flex: none;
    margin-left: 6px;
    padding: 0 4px;
    border: 1px solid var(--rule);
    border-radius: 2px;
    font-size: 9.5px;
    letter-spacing: 0.06em;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 12ch;
  }

  .nav {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    outline: none;
  }

  .tree {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
    min-height: 0;
  }

  /* The cursor is a bar at the pane's left edge, clear of any text: every
     row spans the pane's width, so the bar sits in the same place whatever
     the row's own indent. It shows while the keyboard is in the pane, and
     only then: a highlight that outlives the keyboard would look like a
     second selection. */
  .cursor {
    position: relative;
  }

  .nav:focus-within .cursor::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 3px;
    bottom: 3px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }

  .project,
  .session {
    --row-bg: var(--surface);
    position: relative;
    display: flex;
    align-items: center;
  }

  .session:hover {
    --row-bg: var(--surface-2);
    background: var(--row-bg);
  }

  /* The row's own buttons, over its end on hover, on the row's own colour
     so they read; the text runs under the fade. */
  .actions {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    padding: 0 4px 0 14px;
    background: linear-gradient(to right, transparent, var(--row-bg) 12px);
    opacity: 0;
  }

  .session:hover .actions,
  .actions:focus-within {
    opacity: 1;
  }

  .past-row .past {
    flex: 1;
  }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
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

  .project-row .name {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project.on .project-row .name {
    color: var(--accent);
  }

  .flag {
    font-size: 10px;
    color: var(--ink-3);
    flex: none;
  }

  .session .row,
  .past {
    padding-left: 26px;
  }

  /* Past sessions are history until you open one, so they sit back from the
     live rows rather than competing with them. */
  .past {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 7px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-3);
    cursor: pointer;
    text-align: left;
    padding-right: var(--pane-pad);
  }

  .past:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink-2);
  }

  .past:disabled {
    cursor: default;
  }

  .session.on {
    --row-bg: var(--accent-soft);
    background: var(--row-bg);
  }

  .session.on .label {
    color: var(--accent);
  }

  /* The name keeps a few characters whatever the state says; past that the
     state is what gives way. */
  .label {
    flex: 1;
    min-width: 5ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state {
    font-size: 10px;
    color: var(--ink-3);
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state.told {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .tag {
    flex: none;
    font-size: 9.5px;
    letter-spacing: 0.06em;
    color: var(--ink-3);
    border: 1px solid var(--rule);
    border-radius: 2px;
    padding: 0 4px;
    line-height: 1.4;
  }

  .choice {
    margin: 2px 0 10px;
  }

  .choice-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 2px var(--pane-pad) 2px 26px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    color: var(--ink-3);
  }

  .cancel {
    padding: 0 5px;
    border: 1px solid var(--rule);
    border-radius: 2px;
    background: none;
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    color: var(--ink-3);
    cursor: pointer;
  }

  .cancel:hover {
    color: var(--ink-2);
  }

  .option {
    display: flex;
    align-items: baseline;
    gap: 7px;
    width: 100%;
    text-align: left;
    padding: 3px var(--pane-pad) 3px 26px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .option:hover {
    color: var(--accent);
  }

  .mark {
    flex: none;
    color: var(--ink-3);
  }

  /* A filled dot is a live process; hollow is a row you can still read but
     nothing is running behind. */
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

  /* At work: the dot breathes. Waiting for you: the accent, and the name in
     ink rather than grey, until you look. */
  .dot.working {
    animation: breathe 1.2s ease-in-out infinite;
  }

  .dot.unread {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .label.unread {
    color: var(--ink);
    font-weight: 500;
  }

  /* Asking: a hollow accent ring, whatever else the dot was. */
  .dot.permission {
    background: var(--surface);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
    animation: none;
  }

  @keyframes breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.working {
      animation: none;
    }
  }

  .icon {
    flex: none;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    padding: 2px 8px;
    cursor: pointer;
    opacity: 0;
  }

  .project:hover .icon,
  .session:hover .icon,
  .icon:focus-visible {
    opacity: 1;
  }

  .actions .icon {
    padding: 2px 5px;
  }

  .actions .icon:hover {
    color: var(--accent);
  }

  .new {
    display: block;
    width: 100%;
    text-align: left;
    margin: 2px 0 10px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--pane-pad) 2px 26px;
  }

  .new:hover:not(:disabled) {
    color: var(--accent);
  }

  .new:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
    margin: 0 0 4px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--pane-pad) 2px 26px;
  }

  .fold-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fold:hover {
    color: var(--ink-2);
  }

  .chevron {
    display: inline-block;
    font-size: 9px;
    transition: transform 90ms ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .past.outside {
    margin-bottom: 2px;
  }

  .past.outside:last-of-type {
    margin-bottom: 10px;
  }




  .empty p,
  .error {
    margin: 0;
    padding: 12px var(--pane-pad);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-3);
  }

  .error {
    color: var(--del);
  }

  .section {
    margin: 0;
    padding: 8px var(--pane-pad) 4px;
    border-top: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
    flex: none;
  }

  .recent {
    list-style: none;
    margin: 0;
    padding: 0 0 8px;
    flex: none;
    max-height: 30%;
    overflow-y: auto;
  }

  .recent button {
    display: block;
    width: 100%;
    text-align: left;
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 4px var(--pane-pad);
    border: 0;
    background: none;
    color: var(--ink-2);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent button:hover {
    background: var(--surface-2);
  }
</style>

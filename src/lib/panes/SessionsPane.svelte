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
    type HistoryEntry,
    type Session,
  } from "$lib/sessions.svelte";
  import { activate, close as closeProject, openPath, pick, projectLabel, workspace } from "$lib/workspace.svelte";
  import {
    LABEL,
    conductors,
    foldLabel,
    groupsFor,
    orchestrator,
    ownFor,
    summaryLine,
    type Group,
  } from "$lib/orchestrator.svelte";
  import { startedFor } from "$lib/conductor.svelte";
  import { hostOf, openRemote } from "$lib/remote.svelte";
  import { openResume } from "$lib/resume.svelte";
  import { lastSegment } from "$lib/paths";
  import { focusPane, layout, type PaneId } from "$lib/layout.svelte";

  let notOpen = $derived(workspace.recent.filter((path) => !isOpen(path)));

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

  /** The projects under the orchestrator's own: opening the directory it
      runs in is opening the project already pinned above them, and it is
      drawn once. */
  let projects = $derived(workspace.open.filter((project) => project.path !== orchestrator.dir));

  /** The folds standing open, by the row id of the fold. A fold is where
      the eye is right now, so nothing about it is remembered. */
  let opened = $state<Record<string, boolean>>({});

  /** The head's menu, holding the ways in that are not the everyday one. */
  let menuOpen = $state(false);

  /** An item runs and the menu closes behind it. */
  function fromMenu(run: () => void) {
    run();
    menuOpen = false;
  }

  /** An open menu has the keyboard: Escape closes it, and the rest is the
      menu's own rather than the cursor's. */
  function onMenuKeydown(e: KeyboardEvent) {
    if (!menuOpen) return;
    if (e.key === "Escape") menuOpen = false;
    e.stopPropagation();
  }

  /** A session in the orchestrator's own project, from the menu: the project
      comes forward, and starting there is what the new-session row does. */
  function startOrchestrator() {
    const dir = orchestrator.dir;
    if (dir === null) return;
    activate(dir);
    offer(dir);
  }

  /** The orchestrator's own project, while it has something to show: a
      session of its own, or one to resume there. With neither it is not
      drawn, and the menu is the way to the first one. */
  let pinned = $derived.by(() => {
    const dir = orchestrator.dir;
    if (dir === null) return null;
    return conductors().length > 0 || historyFor(dir).length > 0 ? dir : null;
  });

  const foldId = (project: string, group: Group) => `started:${project}:${group.id}`;

  function toggle(id: string) {
    opened[id] = !opened[id];
  }

  /** The × on a fold: every session behind it stops, and the fold goes with
      the last of them. */
  function stopGroup(group: Group) {
    for (const session of group.sessions) closeSession(session.key);
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
      { id: "menu", run: () => (menuOpen = !menuOpen) },
    ];
    const dir = pinned;
    if (dir !== null) {
      out.push({ id: `project:${dir}`, run: () => activate(dir) });
      for (const session of conductors()) {
        out.push({ id: `session:${session.key}`, run: () => choose(session.key) });
      }
      if (workspace.active === dir) {
        for (const transcript of historyFor(dir)) {
          out.push({
            id: `past:${transcript.id}`,
            run: () => resume(dir, transcript.id, transcript.agent, transcript.cwd ?? null),
          });
        }
        out.push(...starting(dir));
      }
    }
    for (const project of projects) {
      const path = project.path;
      out.push({ id: `project:${path}`, run: () => activate(path) });
      for (const session of ownFor(path)) {
        out.push({ id: `session:${session.key}`, run: () => choose(session.key) });
      }
      for (const group of groupsFor(path)) {
        const id = foldId(path, group);
        out.push({ id, run: () => toggle(id) });
        if (!opened[id]) continue;
        for (const session of group.sessions) {
          out.push({ id: `session:${session.key}`, run: () => choose(session.key) });
        }
      }
      if (workspace.active !== path) continue;
      for (const transcript of historyFor(path)) {
        out.push({
          id: `past:${transcript.id}`,
          run: () => resume(path, transcript.id, transcript.agent, transcript.cwd ?? null),
        });
      }
      out.push(...starting(path));
      for (const agent of AGENTS) {
        if (outsideFor(path, agent).length === 0) continue;
        out.push({ id: `fold:${path}:${agent}`, run: () => openResume(path, agent) });
      }
    }
    for (const path of notOpen) out.push({ id: `recent:${path}`, run: () => openPath(path) });
    return out;
  });

  /** The rows a project offers for starting a session: the choice of agent
      while it is open, else the new-session row. */
  function starting(path: string): Row[] {
    if (!isReady()) return [];
    if (several && choosing === path) {
      return installed().map((agent) => ({
        id: `pick:${path}:${agent}`,
        run: () => startWith(path, agent),
      }));
    }
    return [{ id: `new:${path}`, run: () => offer(path) }];
  }

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
    if (id.startsWith("project:")) {
      // The orchestrator's own project has no close button, and nothing
      // here closes it either.
      const path = id.slice("project:".length);
      if (path !== orchestrator.dir) closeProject(path);
    } else if (id.startsWith("session:")) {
      // A session an orchestrator started is quiet under the fold: the
      // cursor walks through those rows, and a key pressed on the way past
      // is no reason to stop work the orchestrator is waiting on. Its own ×
      // on hover stops it, and the fold's stops the group.
      const key = id.slice("session:".length);
      if (startedFor(key) === null) closeSession(key);
    } else if (id.startsWith("past:") && workspace.active !== null) {
      disown(workspace.active, id.slice("past:".length));
    }
  }

  /** The pane the focus state named last time this was looked at, so an
      arrival from another pane can be told from the keyboard coming back. */
  let previous: PaneId = layout.focus;

  // Focusing the pane by key puts the keyboard here, so the arrows work at
  // once. Arriving from another pane starts the cursor over from the session
  // you are in rather than from whatever a click left it on; the keyboard
  // coming back from a dialog finds the cursor where it was. A click inside
  // already has the keyboard.
  $effect(() => {
    layout.focusRequest;
    const here = layout.focus === "sessions";
    const arrived = here && previous !== "sessions";
    previous = layout.focus;
    if (!here || !nav || nav.contains(document.activeElement)) return;
    if (arrived) cursor = null;
    nav.focus();
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

  /** A past session resumes where it ran: in its worktree when it had one. */
  function resume(path: string, id: string, agent: AgentId, cwd: string | null = null) {
    create(path, id, agent, cwd);
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
        // Closes the menu or an open choice of agent, and goes no further:
        // Escape elsewhere is the agent's.
        if (menuOpen) menuOpen = false;
        else if (!dismiss()) return;
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
    const dir = orchestrator.dir;
    if (dir !== null && sessions.history[dir] === undefined) loadHistory(dir);
  });

  function isOpen(path: string) {
    return workspace.open.some((project) => project.path === path);
  }

</script>

<!-- A session's row, wherever it is drawn. The line beneath the name is
     what the session has out, for one that has started sessions, else what
     the agent left for the row. -->
{#snippet sessionRow(session: Session)}
  {@const summary = summaryLine(session)}
  {@const line = summary ?? session.note}
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
      <!-- The name, and under it what the agent left for the row, if
           anything: the rest of the row centres on the two. -->
      <span class="text">
        <span class="label" class:unread={session.unread}>{label(session)}</span>
        {#if line !== null}
          <span
            class="note"
            title={line}
            data-testid={summary !== null ? "orchestrator-summary" : "session-note"}>{line}</span
          >
        {/if}
      </span>
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
{/snippet}

<!-- A past session, to resume where it ran. -->
{#snippet pastRow(path: string, transcript: HistoryEntry)}
    <div
      class="session past-row"
      class:cursor={current === `past:${transcript.id}`}
      data-row="past:{transcript.id}"
    >
      <button
        class="row past"
        tabindex="-1"
        onclick={() => resume(path, transcript.id, transcript.agent, transcript.cwd ?? null)}
        disabled={!isReady()}
        title={transcript.title ?? transcript.id}
        data-testid="past-session"
      >
        <span class="dot"></span>
        <span class="label">{historyLabel(transcript)}</span>
        {#if transcript.cwd}<span class="tag where" title={transcript.cwd} data-testid="session-where">{lastSegment(transcript.cwd)}</span>{/if}
        {#if several}<span class="tag">{agentTag(transcript.agent)}</span>{/if}
        <span class="state">{ago(transcript.modified)}</span>
      </button>
      <span class="actions">
        <button
          class="icon"
          tabindex="-1"
          onclick={() => disown(path, transcript.id)}
          aria-label="Archive {historyLabel(transcript)}"
          title="File with the sessions to resume"
          data-testid="archive-past">↧</button
        >
      </span>
    </div>
{/snippet}

<!-- With several agents the row opens, in place, into the choice of
     agent; with one there is nothing to choose and it starts. -->
{#snippet newSession(path: string)}
  {#if several && choosing === path}
    <div class="choice" role="group" aria-label="Agent for the new session" data-testid="agent-choice">
      <div class="choice-head">
        <span>new session with</span>
        <button class="cancel" tabindex="-1" onclick={dismiss} aria-label="Cancel" data-testid="choice-cancel"
          >Esc</button
        >
      </div>
      {#each installed() as id (id)}
        <button
          class="option"
          class:cursor={current === `pick:${path}:${id}`}
          tabindex="-1"
          onclick={() => startWith(path, id)}
          data-row="pick:{path}:{id}"
          data-testid="agent-option"
          data-agent={id}
        >
          <span class="mark">›</span>
          <span class="label">{agentLabel(id)}</span>
          {#if sessions.preferred[path] === id}<span class="state">last used</span>{/if}
        </button>
      {/each}
    </div>
  {:else}
    <div class="new-row" class:cursor={current === `new:${path}`} data-row="new:{path}">
      <button
        class="new"
        tabindex="-1"
        onclick={() => offer(path)}
        disabled={!isReady()}
        data-testid="new-session">+ New session</button
      >
    </div>
  {/if}
{/snippet}

<Pane id="sessions" title="Projects &amp; sessions" meta="">
  {#if workspace.error}
    <div class="error-row">
      <p class="error" data-testid="project-error">{workspace.error}</p>
      <button
        class="dismiss"
        tabindex="-1"
        onclick={() => (workspace.error = null)}
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="project-error-dismiss">×</button
      >
    </div>
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
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="more" onkeydown={onMenuKeydown}>
      <button
        class="tool"
        class:cursor={current === "menu"}
        tabindex="-1"
        onclick={() => (menuOpen = !menuOpen)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More"
        title="More"
        data-row="menu"
        data-testid="sessions-menu">⋯</button
      >
      {#if menuOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="scrim" onclick={() => (menuOpen = false)}></div>
        <div class="menu" role="menu" data-testid="sessions-menu-items">
          <button
            role="menuitem"
            onclick={() => fromMenu(openRemote)}
            disabled={workspace.opening}
            title="A project on another machine, over ssh"
            data-testid="open-remote"
          >
            <span>Remote…</span>
          </button>
          <button
            role="menuitem"
            onclick={() => fromMenu(startOrchestrator)}
            disabled={orchestrator.dir === null || !isReady()}
            data-testid="menu-orchestrator"
          >
            <span>New orchestrator session</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
  <div class="tree">
    <!-- The orchestrator's own project, above the ones you opened: a session
         that directs others runs here, and starts here like any other. -->
    {#if pinned !== null}
      {@const dir = pinned}
      <div
        class="project"
        class:on={workspace.active === dir}
        class:cursor={current === `project:${dir}`}
        data-row="project:{dir}"
      >
        <button
          class="row project-row"
          tabindex="-1"
          onclick={() => activate(dir)}
          title={dir}
          data-testid="orchestrator-project"
        >
          <span class="name">{LABEL}</span>
        </button>
      </div>

      {#each conductors() as session (session.key)}
        {@render sessionRow(session)}
      {/each}

      {#if workspace.active === dir}
        {#each historyFor(dir) as transcript (transcript.id)}
          {@render pastRow(dir, transcript)}
        {/each}
        {@render newSession(dir)}
      {/if}
    {/if}

    {#each projects as project (project.path)}
      {@const own = ownFor(project.path)}
      <div
        class="project"
        class:on={workspace.active === project.path}
        class:cursor={current === `project:${project.path}`}
        data-row="project:{project.path}"
      >
        <button class="row project-row" tabindex="-1" onclick={() => activate(project.path)} title={project.path}>
          <span class="name">{projectLabel(project.path)}</span>
          {#if hostOf(project.path) !== null}<span class="host" data-testid="project-host">{hostOf(project.path)}</span>{/if}
          {#if !project.isGit}<span class="flag" title="Not a git repository">no git</span>{/if}
        </button>
        <button
          class="icon"
          tabindex="-1"
          onclick={() => closeProject(project.path)}
          aria-label="Close {projectLabel(project.path)}"
          data-testid="close-project">×</button
        >
      </div>

      {#each own as session (session.key)}
        {@render sessionRow(session)}
      {/each}

      <!-- What an orchestrator started here stays in the project it runs in
           and keeps out of the way: one line for each orchestrator, and the
           sessions themselves behind it. -->
      {#each groupsFor(project.path) as group (group.id)}
        {@const id = foldId(project.path, group)}
        <div class="fold-row">
          <button
            class="fold"
            class:cursor={current === id}
            tabindex="-1"
            onclick={() => toggle(id)}
            data-row={id}
            data-testid="started-fold"
          >
            <span class="chevron" class:open={opened[id]}>▸</span>
            <span class="fold-text">{foldLabel(group)}</span>
            {#if group.asking > 0}
              <span class="asking"><span class="ring"></span>{group.asking} asking</span>
            {/if}
          </button>
          <!-- Over the row's end, as a session's own × is. -->
          <span class="actions">
            <button
              class="icon"
              tabindex="-1"
              onclick={() => stopGroup(group)}
              aria-label="Stop the sessions {group.label} started"
              title="Stop these"
              data-testid="stop-started">×</button
            >
          </span>
        </div>
        {#if opened[id]}
          {#each group.sessions as session (session.key)}
            <div
              class="session started"
              class:on={sessions.active === session.key}
              class:cursor={current === `session:${session.key}`}
              data-row="session:{session.key}"
            >
              <button
                class="row"
                tabindex="-1"
                onclick={() => choose(session.key)}
                data-testid="started-session"
              >
                <span
                  class="dot"
                  class:live={isLive(session)}
                  class:working={session.working}
                  class:unread={session.unread}
                  class:permission={session.needs === "permission"}
                  title={statusLabel(session)}
                ></span>
                <span class="label" class:unread={session.unread}>{label(session)}</span>
                <span class="state told">{statusLabel(session)}</span>
              </button>
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
        {/if}
      {/each}

      {#if workspace.active === project.path}
        {#each historyFor(project.path) as transcript (transcript.id)}
          {@render pastRow(project.path, transcript)}
        {/each}

        {@render newSession(project.path)}

        <!-- An agent run in a plain terminal here leaves its sessions in the
             same place. They are resumable, so they are here, one row per
             agent that opens the list, rather than mixed in with what this
             window started. -->
        {#each AGENTS as agent (agent)}
          {@const outside = outsideFor(project.path, agent)}
          {@const fold = `${project.path}:${agent}`}
          {#if outside.length > 0}
            <button
              class="fold"
              class:cursor={current === `fold:${fold}`}
              tabindex="-1"
              onclick={() => openResume(project.path, agent)}
              data-row="fold:{fold}"
              data-agent={agent}
              data-testid="outside-fold"
            >
              <span class="chevron">▸</span>
              <span class="fold-text"
                >{`${outside.length} ${agentTag(agent)} ${outside.length === 1 ? "session" : "sessions"} to resume`}</span
              >
            </button>
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
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  .head > button {
    flex: 1;
    min-width: 0;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 9px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }

  .head > button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .head > button.cursor,
  .tool.cursor {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .nav:focus-within .head .cursor::before {
    content: none;
  }

  /* The way in is the accent; everything else the head offers is behind the
     quieter button beside it. */
  .more {
    position: relative;
    flex: none;
  }

  .tool {
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: 14px;
    line-height: 1;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tool:hover {
    color: var(--ink);
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 4;
  }

  /* Two short items, in a pane that can be narrower than the changes
     pane's menu: sized to fit inside the pane rather than past its edge. */
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 184px;
    padding: 4px 0;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px color-mix(in srgb, black 25%, transparent);
  }

  .menu button {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 5px var(--pane-pad);
    border: 0;
    background: none;
    font-size: 12.5px;
    color: var(--ink-2);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .menu button:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  .menu button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* Where a project is, when it is not here. */
  .host {
    flex: none;
    margin-left: 6px;
    padding: 0 4px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    font-size: 9.5px;
    letter-spacing: var(--label-track-fine);
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
    --row-bg: var(--pane-bg);
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 var(--row-inset);
    border-radius: var(--radius);
  }

  .new-row {
    margin: 0 var(--row-inset);
    border-radius: var(--radius);
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

  .project-row .name {
    color: var(--ink);
    font-weight: var(--project-weight);
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
    padding-left: var(--row-indent);
  }

  /* Past sessions are history until you open one, so they sit back from the
     live rows rather than competing with them. */
  .past {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 7px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-3);
    cursor: pointer;
    text-align: left;
    padding-right: var(--row-pad-x);
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
  .text {
    flex: 1;
    min-width: 5ch;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .label,
  .note {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* What the agent left for the row: a line under the name, in the same
     hand, quieter. */
  .note {
    font-size: 10.5px;
    line-height: 1.35;
    color: var(--ink-3);
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

  /* Where a past session ran, when not in the project itself. */
  .tag.where {
    color: var(--accent);
    border-color: var(--accent-soft);
    max-width: 10ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    flex: none;
    font-size: 9.5px;
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
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
    padding: 2px var(--row-pad-x) 2px var(--row-indent);
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: 0.05em;
    color: var(--ink-3);
  }

  .cancel {
    padding: 0 5px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    background: none;
    font-family: var(--chrome);
    font-size: 9.5px;
    letter-spacing: var(--label-track-fine);
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
    padding: 3px var(--row-pad-x) 3px var(--row-indent);
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
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
  .fold-row:hover .icon,
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
    font-family: var(--chrome);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--row-pad-x) 2px var(--row-indent);
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
    font-family: var(--chrome);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--row-pad-x) 2px var(--row-indent);
  }

  /* A fold and the button that stops what is behind it, on one row. */
  .fold-row {
    --row-bg: var(--pane-bg);
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 var(--row-inset) 4px;
    border-radius: var(--radius);
  }

  .fold-row .fold {
    margin: 0;
  }

  .fold-row:hover {
    --row-bg: var(--surface-2);
    background: var(--row-bg);
  }

  .fold-row:hover .actions,
  .fold-row .actions:focus-within {
    opacity: 1;
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

  /* Closed, the triangle points at what it is holding; open, it points down
     at the rows it let out. */
  .chevron.open {
    transform: rotate(90deg);
  }

  /* One of the sessions behind the fold is waiting on you. */
  .asking {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
  }

  .ring {
    width: var(--dot);
    height: var(--dot);
    flex: none;
    border: 1px solid var(--accent);
    border-radius: 50%;
  }

  /* A session an orchestrator started, out from behind its fold: past the
     triangle, and quieter than a session of the project's own. */
  .session.started .row {
    padding-left: calc(var(--row-indent) + 14px);
    font-size: 11px;
    color: var(--ink-3);
  }

  .session.started .label {
    flex: 1;
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

  .error-row {
    display: flex;
    align-items: flex-start;
  }

  .error-row .error {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dismiss {
    flex: none;
    margin: 10px var(--pane-pad) 0 0;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 4px;
  }

  .dismiss:hover {
    color: var(--ink);
  }

  .section {
    margin: 0;
    padding: 8px var(--pane-pad) 4px;
    border-top: 1px solid var(--head-rule);
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
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
    width: calc(100% - 2 * var(--row-inset));
    margin: 0 var(--row-inset);
    text-align: left;
    font-family: var(--chrome);
    font-size: var(--row-size);
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    border-radius: var(--radius);
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

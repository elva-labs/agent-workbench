<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import { AGENTS, agentLabel, agentTag, installed, isReady } from "$lib/agent.svelte";
  import { accountLabel, accountOf, hasAccounts, names } from "$lib/accounts.svelte";
  import type { AgentId } from "$lib/core";
  import {
    ago,
    byChange,
    close as closeSession,
    create,
    defaultAgent,
    historyFor,
    historyLabel,
    isLive,
    label,
    loadHistory,
    outsideFor,
    sessions,
    since,
    statusLabel,
    disown,
    type HistoryEntry,
    type Session,
  } from "$lib/sessions.svelte";
  import { activate, close as closeProject, goTo, pick, projectLabel, workspace } from "$lib/workspace.svelte";
  import {
    LABEL,
    conducting,
    conductors,
    foldLabel,
    groupsFor,
    orchestrator,
    ownFor,
    summaryLine,
    type Group,
  } from "$lib/orchestrator.svelte";
  import { startedFor, stopStarted } from "$lib/conductor.svelte";
  import { hostOf, openRemote } from "$lib/remote.svelte";
  import { openResume } from "$lib/resume.svelte";
  import { lastSegment } from "$lib/paths";
  import {
    focusPane,
    layout,
    peekSessions,
    sessionsShown,
    sessionsVisible,
    setProjectSort,
    type PaneId,
    type ProjectSort,
  } from "$lib/layout.svelte";
  import { lastUsed, splitProjects } from "$lib/projects.svelte";
  import { unfoldSessions } from "$lib/viewers.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import { flip } from "svelte/animate";
  import { rowFade, rowMove } from "$lib/motion";


  /** With more than one agent to run, every row says which it is, and the
      new-session row offers the choice. With one, nothing changes. */
  let several = $derived(installed().length > 1);

  /** Whether the new-session row has anything to choose: an agent, or an
      account to run under. */
  let choosable = $derived(several || hasAccounts());

  /** The project whose new-session row is open on the choice of agent. */
  let choosing = $state<string | null>(null);

  /** The account the open choice would start under: the project's own to
      begin with, and whatever the control was switched to. */
  let picked = $state<string | null>(null);

  /** New session: with nothing to choose it starts; otherwise the row
      opens into the choice, the cursor on the agent the project used last
      and the account the project runs under. */
  function offer(path: string) {
    if (!choosable) {
      start(path, defaultAgent(path));
      return;
    }
    choosing = path;
    picked = accountOf(path);
    cursor = `pick:${path}:${defaultAgent(path)}`;
  }

  function startWith(path: string, agent: AgentId) {
    choosing = null;
    start(path, agent, picked);
  }

  /** The accounts the control offers, the agents' own first. */
  let offered = $derived<(string | null)[]>([null, ...names()]);

  /** Left and Right in the choice walk the accounts. */
  function pickNext(step: number) {
    const at = offered.indexOf(picked);
    picked = offered[(at + step + offered.length) % offered.length] ?? null;
  }

  /** The folds standing open, by the row id of the fold. A fold is where
      the eye is right now, so nothing about it is remembered. */
  let opened = $state<Record<string, boolean>>({});

  /** The minute the times on the rows are read against, and the split
      into active and inactive with them. */
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** The projects under the orchestrator's own: opening the directory it
      runs in is opening the project already pinned above them, and it is
      drawn once. They are split into the ones in use and the ones folded
      under Inactive, each in the order the sort menu says. */
  let split = $derived.by(() => {
    const byPath = new Map(
      workspace.open.filter((project) => project.path !== orchestrator.dir).map((project) => [project.path, project]),
    );
    const { active, inactive } = splitProjects([...byPath.keys()], workspace.active, layout.projectSort, now);
    return {
      active: active.map((path) => byPath.get(path)!),
      inactive: inactive.map((path) => byPath.get(path)!),
    };
  });

  /** How many inactive projects stand under the fold before the rest go
      behind a row of their own. */
  const INACTIVE_SHOWN = 7;

  /** The inactive projects drawn once the fold is open: all of them, or
      the first few and a row for the rest. */
  let idle = $derived(
    opened["idle-more"] || split.inactive.length <= INACTIVE_SHOWN + 1
      ? split.inactive
      : split.inactive.slice(0, INACTIVE_SHOWN),
  );

  /** The orders the sort menu offers. */
  const SORTS: { sort: ProjectSort; label: string }[] = [
    { sort: "used", label: "Last used" },
    { sort: "name", label: "Name" },
  ];

  /** The sort menu, and the item its keyboard cursor is on while open. */
  let sortOpen = $state(false);
  let sortAt = $state(0);

  function openSort() {
    sortOpen = !sortOpen;
    sortAt = Math.max(
      0,
      SORTS.findIndex((choice) => choice.sort === layout.projectSort),
    );
  }

  function pickSort(sort: ProjectSort) {
    setProjectSort(sort);
    sortOpen = false;
  }

  /** An inactive project's own new-session button: the project comes
      forward, which makes it active, and starts as its own row would. */
  function startIn(path: string) {
    activate(path);
    offer(path);
  }

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
    // Active counts too: choosing the agent for the first one happens
    // under the project's own row, which has to be there to hold it.
    const shows =
      conductors().length > 0 || historyFor(dir).length > 0 || workspace.active === dir;
    return shows ? dir : null;
  });

  const foldId = (project: string, group: Group) => `started:${project}:${group.id}`;

  function toggle(id: string) {
    opened[id] = !opened[id];
  }

  /** The × on a fold: every session behind it stops, and the fold goes with
      the last of them. */
  function stopGroup(group: Group) {
    for (const session of group.sessions) stopStarted(session.key);
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
      { id: "sort", run: openSort },
    ];
    const dir = pinned;
    if (dir !== null) {
      out.push({ id: `project:${dir}`, run: () => activate(dir) });
      for (const session of byChange(conductors())) {
        out.push({ id: `session:${session.key}`, run: () => choose(session.key) });
      }
      if (workspace.active === dir) out.push(...rest(dir));
    }
    for (const project of split.active) {
      const path = project.path;
      out.push({ id: `project:${path}`, run: () => activate(path) });
      for (const session of byChange(ownFor(path))) {
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
      if (workspace.active === path) out.push(...rest(path));
    }
    if (split.inactive.length > 0) {
      out.push({ id: "inactive", run: () => toggle("inactive") });
      if (opened.inactive) {
        for (const project of idle) {
          const path = project.path;
          out.push({ id: `idle:${path}`, run: () => activate(path) });
        }
        if (idle.length < split.inactive.length) out.push({ id: "idle-more", run: () => toggle("idle-more") });
      }
    }
    return out;
  });

  /** The rows under the project you are looking at, after its sessions:
      the past ones, the way to a new one, and the folds of sessions from
      outside. The orchestrator's own project has no outside. */
  function rest(path: string): Row[] {
    const out: Row[] = [];
    for (const transcript of historyFor(path)) {
      out.push({
        id: `past:${transcript.id}`,
        run: () => resume(path, transcript),
      });
    }
    out.push(...starting(path));
    if (path === orchestrator.dir) return out;
    for (const agent of AGENTS) {
      if (outsideFor(path, agent).length === 0) continue;
      out.push({ id: `fold:${path}:${agent}`, run: () => openResume(path, agent) });
    }
    return out;
  }

  /** The rows a project offers for starting a session: the choice of agent
      while it is open, else the new-session row. */
  function starting(path: string): Row[] {
    if (!isReady()) return [];
    if (choosable && choosing === path) {
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
    if (id.startsWith("idle:")) {
      closeProject(id.slice("idle:".length));
    } else if (id.startsWith("project:")) {
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
    if (goTo(key)) focusPane("agent");
  }

  /** A past session resumes where it ran: in its worktree when it had
      one, and under the account it ran under. */
  function resume(path: string, transcript: HistoryEntry) {
    create(path, transcript.id, transcript.agent, transcript.cwd ?? null, null, null, transcript.account);
    focusPane("agent");
  }

  function start(path: string, agent: AgentId, account: string | null = accountOf(path)) {
    create(path, null, agent, null, null, null, account);
    focusPane("agent");
  }

  function moveTo(index: number) {
    if (rows.length === 0) return;
    const at = Math.max(0, Math.min(index, rows.length - 1));
    cursor = rows[at].id;
    nav.querySelector(`[data-row="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(e: KeyboardEvent) {
    if (sortOpen && onSortKeydown(e)) {
      nav.focus();
      e.preventDefault();
      return;
    }
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
      case "ArrowLeft":
      case "ArrowRight":
        if (choosing !== null && hasAccounts()) pickNext(e.key === "ArrowLeft" ? -1 : 1);
        else return;
        break;
      case "Escape":
        // Closes the menu or an open choice of agent, then puts a peeked
        // pane back, and goes no further: Escape elsewhere is the agent's,
        // or closes the viewer.
        if (menuOpen) menuOpen = false;
        else if (dismiss()) {
          // The choice is gone; the pane stays.
        } else if (layout.sessionsPeek) peekSessions(false);
        else return;
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

  /** While the sort menu is open the arrows walk its items, Enter picks
      one and Escape closes it. False for a key the menu leaves alone. */
  function onSortKeydown(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        sortAt = Math.min(sortAt + 1, SORTS.length - 1);
        return true;
      case "ArrowUp":
        sortAt = Math.max(sortAt - 1, 0);
        return true;
      case "Enter":
      case " ":
        pickSort(SORTS[sortAt].sort);
        return true;
      case "Escape":
        sortOpen = false;
        e.stopPropagation();
        return true;
      default:
        return false;
    }
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

  /** Folded to its narrow column: the rows keep their places, and the pane
      is one button that opens it. Peeked over the agent, it is open. */
  let folded = $derived(!sessionsShown());
  /** Reviewing folds the pane, and the column peeks it over the agent; a
      window too narrow for it has nothing to open it into. */
  let unfoldable = $derived(layout.mode === "reviewing" || !layout.sessionsForced);

  /** The column was clicked: while reviewing the pane peeks over the
      agent, so the viewer stays; otherwise it opens for real. */
  function unfold() {
    if (layout.mode === "reviewing") peekSessions(true);
    else unfoldSessions();
    focusPane("sessions");
  }

  /** How long the pointer rests on the column before the pane peeks, so a
      pointer crossing it on the way to the agent does not flash it, and
      how long it is gone before the pane goes back. */
  const PEEK_AFTER = 200;
  const UNPEEK_AFTER = 300;

  // The pointer resting on the folded column peeks the pane over the agent
  // while reviewing, and leaving the pane puts it back, unless the keyboard
  // is in it: then Escape, Enter or the focus chord put it back.
  $effect(() => {
    const pane = nav?.closest<HTMLElement>('[data-pane="sessions"]');
    if (!pane) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (what: () => void, after: number) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        what();
      }, after);
    };
    const enter = () => {
      if (layout.mode !== "reviewing" || sessionsVisible() || layout.sessionsPeek) return;
      later(() => peekSessions(true), PEEK_AFTER);
    };
    const leave = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!layout.sessionsPeek || layout.focus === "sessions") return;
      later(() => peekSessions(false), UNPEEK_AFTER);
    };
    pane.addEventListener("pointerenter", enter);
    pane.addEventListener("pointerleave", leave);
    return () => {
      if (timer !== null) clearTimeout(timer);
      pane.removeEventListener("pointerenter", enter);
      pane.removeEventListener("pointerleave", leave);
    };
  });

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
        class:dormant={session.status === "dormant"}
        class:working={conducting(session)}
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
        onclick={() => resume(path, transcript)}
        disabled={!isReady()}
        title={transcript.title ?? transcript.id}
        data-testid="past-session"
      >
        <span class="dot"></span>
        <span class="label">{historyLabel(transcript)}</span>
        {#if transcript.cwd}<span class="tag where" title={transcript.cwd} data-testid="session-where">{lastSegment(transcript.cwd)}</span>{/if}
        {#if transcript.account !== null}<span class="tag account" data-testid="past-account">{transcript.account}</span>{/if}
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

<!-- A project's name, with the part of the path that tells it from
     another of the same name dimmed in front of it. -->
{#snippet projectName(path: string)}
  {@const full = projectLabel(path)}
  {@const cut = full.lastIndexOf("/") + 1}
  {#if cut > 0}<span class="prefix">{full.slice(0, cut)}</span>{/if}{full.slice(cut)}
{/snippet}

<!-- A project's own row: its name, and what tells it apart. -->
{#snippet projectRow(project: { path: string; isGit: boolean })}
  <div
    class="project"
    class:on={workspace.active === project.path}
    class:cursor={current === `project:${project.path}`}
    data-row="project:{project.path}"
  >
    <button class="row project-row" tabindex="-1" onclick={() => activate(project.path)} title={project.path}>
      <span class="name">{projectLabel(project.path)}</span>
      {#if accountOf(project.path) !== null}<span class="tag account" data-testid="project-account">{accountOf(project.path)}</span>{/if}
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
{/snippet}

<!-- The orchestrator's own project: nothing closes it. -->
{#snippet pinnedRow(dir: string)}
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
{/snippet}

<!-- What the project you are looking at offers under its sessions: the
     past ones, the way to a new one, and the sessions from outside. -->
{#snippet projectRest(path: string)}
  {#each historyFor(path) as transcript (transcript.id)}
    <div class="row-slot" animate:flip={rowMove()} in:rowFade|local out:rowFade|local>
      {@render pastRow(path, transcript)}
    </div>
  {/each}

  {@render newSession(path)}

  <!-- An agent run in a plain terminal here leaves its sessions in the
       same place. They are resumable, so they are here, one row per
       agent that opens the list, rather than mixed in with what this
       window started. -->
  {#if path !== orchestrator.dir}
    {#each AGENTS as agent (agent)}
      {@const outside = outsideFor(path, agent)}
      {@const fold = `${path}:${agent}`}
      {#if outside.length > 0}
        <button
          class="fold"
          class:cursor={current === `fold:${fold}`}
          tabindex="-1"
          onclick={() => openResume(path, agent)}
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
{/snippet}

<!-- With several agents, or accounts to run under, the row opens, in
     place, into the choice; with neither there is nothing to choose and it
     starts. -->
{#snippet newSession(path: string)}
  {#if choosable && choosing === path}
    <div class="choice" role="group" aria-label="Agent for the new session" data-testid="agent-choice">
      <div class="choice-head">
        <span>new session {hasAccounts() ? "as" : "with"}</span>
        <button class="cancel" tabindex="-1" onclick={dismiss} aria-label="Cancel" data-testid="choice-cancel"
          >Esc</button
        >
      </div>
      <!-- The account comes before the agent: the control takes the row's
           width under the head, and the agents follow under "with". -->
      {#if hasAccounts()}
        <div class="accounts" role="radiogroup" aria-label="Account for the new session" data-testid="account-choice">
          {#each offered as account (account ?? "")}
            <button
              role="radio"
              tabindex="-1"
              aria-checked={picked === account}
              class:on={picked === account}
              onclick={() => (picked = account)}
              data-testid="account-option"
              data-account={account ?? ""}>{accountLabel(account)}</button
            >
          {/each}
        </div>
        <div class="choice-head"><span>with</span></div>
      {/if}
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
  {#if folded}
    <button
      class="unfold"
      tabindex="-1"
      onpointerdown={(e) => e.preventDefault()}
      onclick={unfold}
      disabled={!unfoldable}
      aria-label="Show sessions"
      title="Show sessions ({describe(chordFor('toggle.sessions'))})"
      data-testid="unfold-sessions"><span class="unfold-mark" aria-hidden="true">›</span></button
    >
  {/if}

  {#if workspace.error}
    <div class="error-row" class:folded inert={folded}>
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
    <div class="empty" class:folded inert={folded} data-testid="no-project">
      <p>Open a folder to work in. A session starts there, and the changes pane watches it.</p>
    </div>
  {/if}

  <!-- One tab stop with a cursor inside, the tree's pattern. The rows stay
       buttons for the mouse; the keyboard goes through here. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="nav"
    class:folded
    inert={folded}
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
            <span>Open remote project…</span>
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
  <!-- The projects' heading, with the order they are listed in: a menu
       on the cursor path, whose items the arrows walk while it is open. -->
  <div class="sortbar">
    <span class="sort-title">Projects</span>
    <button
      class="sort"
      class:cursor={current === "sort"}
      class:open={sortOpen}
      tabindex="-1"
      onclick={openSort}
      aria-haspopup="menu"
      aria-expanded={sortOpen}
      data-row="sort"
      data-testid="project-sort"
      >{SORTS.find((choice) => choice.sort === layout.projectSort)?.label}<svg viewBox="0 0 16 16" aria-hidden="true"
        ><path d="m4 6 4 4 4-4" /></svg
      ></button
    >
    {#if sortOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="scrim" onclick={() => (sortOpen = false)}></div>
      <div class="menu sort-menu" role="menu" data-testid="project-sort-menu">
        {#each SORTS as choice, index (choice.sort)}
          <button
            role="menuitemradio"
            tabindex="-1"
            aria-checked={layout.projectSort === choice.sort}
            class:at={sortAt === index}
            onclick={() => pickSort(choice.sort)}
            data-testid="project-sort-{choice.sort}"
          >
            <span>{choice.label}</span>
            {#if layout.projectSort === choice.sort}<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"
                ><path d="m3.5 8.5 3 3 6-7" /></svg
              >{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="tree">
      <!-- The orchestrator's own project, above the ones you opened: a session
           that directs others runs here, and starts here like any other. -->
      {#if pinned !== null}
        {@const dir = pinned}
        {@render pinnedRow(dir)}

        <!-- Each row is drawn in a slot of its own, which is what fades and
             what moves: a row that goes leaves the ones below it to close the
             gap rather than jump into it. -->
        {#each byChange(conductors()) as session (session.key)}
          <div class="row-slot" animate:flip={rowMove()} in:rowFade|local out:rowFade|local>
            {@render sessionRow(session)}
          </div>
        {/each}

        {#if workspace.active === dir}
          {@render projectRest(dir)}
        {/if}
      {/if}

      {#each split.active as project (project.path)}
        {@const own = byChange(ownFor(project.path))}
        {@render projectRow(project)}

        {#each own as session (session.key)}
          <div class="row-slot" animate:flip={rowMove()} in:rowFade|local out:rowFade|local>
            {@render sessionRow(session)}
          </div>
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
                animate:flip={rowMove()}
                in:rowFade|local
                out:rowFade|local
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
          {@render projectRest(project.path)}
        {/if}
      {/each}

      <!-- The projects nobody has used for a while, folded at the foot:
           each with when it was last used, a way to start a session in it,
           and its close button. Picking one brings it forward, and it is
           in use again. -->
      {#if split.inactive.length > 0}
        <div class="inactive" data-testid="inactive">
          <button
            class="inactive-head"
            class:cursor={current === "inactive"}
            tabindex="-1"
            onclick={() => toggle("inactive")}
            aria-expanded={opened.inactive === true}
            data-row="inactive"
            data-testid="inactive-fold"
          >
            <span class="chevron" class:open={opened.inactive}>▸</span>
            <span class="inactive-title">Inactive</span>
            <span class="inactive-count"
              >{split.inactive.length} {split.inactive.length === 1 ? "project" : "projects"}</span
            >
          </button>
          {#if opened.inactive}
            {#each idle as project (project.path)}
              {@const used = lastUsed(project.path)}
              <div
                class="idle"
                class:cursor={current === `idle:${project.path}`}
                data-row="idle:{project.path}"
                in:rowFade|local
                out:rowFade|local
              >
                <button
                  class="row idle-row"
                  tabindex="-1"
                  onclick={() => activate(project.path)}
                  title={project.path}
                  data-testid="inactive-project"
                >
                  <span class="name">{@render projectName(project.path)}</span>
                  {#if accountOf(project.path) !== null}<span class="tag account">{accountOf(project.path)}</span>{/if}
                  {#if hostOf(project.path) !== null}<span class="host">{hostOf(project.path)}</span>{/if}
                  <span class="when" data-testid="inactive-when">{used === null ? "" : since(used, now)}</span>
                </button>
                <span class="actions">
                  <button
                    class="icon"
                    tabindex="-1"
                    onclick={() => startIn(project.path)}
                    disabled={!isReady()}
                    aria-label="New session in {projectLabel(project.path)}"
                    title="New session"
                    data-testid="inactive-new-session">+</button
                  >
                  <button
                    class="icon"
                    tabindex="-1"
                    onclick={() => closeProject(project.path)}
                    aria-label="Close {projectLabel(project.path)}"
                    title="Close"
                    data-testid="close-project">×</button
                  >
                </span>
              </div>
            {/each}
            {#if idle.length < split.inactive.length}
              <button
                class="fold idle-more"
                class:cursor={current === "idle-more"}
                tabindex="-1"
                onclick={() => toggle("idle-more")}
                data-row="idle-more"
                data-testid="inactive-more">{split.inactive.length - idle.length} more</button
              >
            {/if}
          {/if}
        </div>
      {/if}
  </div>
  </div>
</Pane>

<style>
  /* The button the folded pane is, laid over it so a click anywhere opens
     it, with its mark where the way in stands when the pane is open. */
  :global([data-pane="sessions"] > .body) {
    position: relative;
  }

  .unfold {
    position: absolute;
    inset: 0;
    z-index: 3;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }

  .unfold:disabled {
    cursor: default;
  }

  .unfold-mark {
    position: absolute;
    top: 8px;
    left: 0;
    width: var(--folded);
    height: 26px;
    display: grid;
    place-items: center;
    font-family: var(--chrome);
    font-size: 15px;
    color: var(--ink-3);
  }

  .unfold:hover:not(:disabled) .unfold-mark {
    color: var(--accent);
  }

  .unfold:disabled .unfold-mark {
    visibility: hidden;
  }

  /* Folded, every row keeps its place and its height and shows only what
     says whose sessions these are: a project's name, cut at the column's
     edge, and the dots of the sessions under it. Nothing moves when the pane
     opens again. */
  .nav.folded {
    mask-image: linear-gradient(to right, #000 calc(var(--folded) - 14px), transparent calc(var(--folded) - 3px));
  }

  .nav.folded .project-row .name {
    text-overflow: clip;
  }

  .nav.folded .head,
  .nav.folded .text,
  .nav.folded .label,
  .nav.folded .tag,
  .nav.folded .state,
  .nav.folded .actions,
  .nav.folded .icon,
  .nav.folded .host,
  .nav.folded .flag,
  .nav.folded .new,
  .nav.folded .fold,
  .nav.folded .sortbar,
  .nav.folded .inactive,
  .nav.folded .choice,
  .nav.folded .cursor::before,
  .error-row.folded,
  .empty.folded {
    visibility: hidden;
  }

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

  /* The projects' heading: a quiet line with the order they are listed in
     at its end, behind a menu. */
  .sortbar {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    margin: 10px var(--row-inset) 2px;
    padding: 0 var(--row-pad-x);
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  .sort-title {
    font-weight: var(--heading-weight);
  }

  .sort {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 4px 2px 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    cursor: pointer;
  }

  .sort svg,
  .sort-menu .tick {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  .sort:hover,
  .sort.open {
    background: var(--surface-2);
    color: var(--ink);
  }

  .sort.cursor {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .nav:focus-within .sort.cursor::before {
    content: none;
  }

  .sort-menu {
    top: calc(100% + 2px);
    right: var(--row-pad-x);
    min-width: 150px;
  }

  .sort-menu button {
    align-items: center;
  }

  .sort-menu button.at {
    background: var(--surface-2);
    color: var(--ink);
  }

  .sort-menu .tick {
    color: var(--accent);
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
    /* The fill moves from row to row rather than jumping between them. */
    transition: background-color 120ms ease;
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

  /* The account a project runs under, when it is not the agents' own. */
  .tag.account {
    color: var(--accent);
    border-color: var(--accent-soft);
    max-width: 10ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The account the choice starts under, switched for this one session:
     one segment per account, sharing the row's width. */
  .accounts {
    display: flex;
    margin: 2px var(--row-pad-x) 4px var(--row-indent);
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    overflow: hidden;
  }

  .accounts button {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .accounts button:hover {
    color: var(--ink-2);
  }

  .accounts button:last-child {
    border-right: 0;
  }

  .accounts button.on {
    background: var(--accent-soft);
    color: var(--accent);
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

  /* Open when the app last quit, and not started since: it starts when
     selected. */
  .dot.dormant {
    background: var(--dormant);
    border-color: var(--dormant);
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

    .project,
    .session {
      transition: none;
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







  /* The projects nobody has used for a while: one fold at the foot, behind
     a hairline, each project a single line with when it was last used. */
  .inactive {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--rule);
  }

  .inactive-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: calc(100% - 2 * var(--row-inset));
    margin: 0 var(--row-inset);
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    text-align: left;
    color: var(--ink-2);
    cursor: pointer;
  }

  .inactive-head:hover {
    background: var(--surface-2);
  }

  .inactive-title {
    font-weight: var(--project-weight);
  }

  .inactive-count {
    color: var(--ink-3);
  }

  .idle {
    --row-bg: var(--pane-bg);
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 var(--row-inset);
    border-radius: var(--radius);
  }

  .idle:hover {
    --row-bg: var(--surface-2);
    background: var(--row-bg);
  }

  .idle:hover .actions,
  .idle .actions:focus-within {
    opacity: 1;
  }

  .idle:hover .icon {
    opacity: 1;
  }

  .idle-row {
    padding-left: var(--row-indent);
  }

  .idle-row .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prefix {
    color: var(--ink-3);
    font-weight: normal;
  }

  .when {
    flex: none;
    margin-left: auto;
    padding-left: 10px;
    font-size: var(--label-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
  }

  .idle-more {
    padding-left: var(--row-indent);
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
</style>

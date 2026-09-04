<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import { isReady } from "$lib/agent.svelte";
  import {
    ago,
    byKey,
    close as closeSession,
    create,
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
  } from "$lib/sessions.svelte";
  import { activate, close as closeProject, openPath, pick, workspace } from "$lib/workspace.svelte";
  import { check, hook, isInstalled, isKnown, toggle } from "$lib/hook.svelte";
  import { focusPane, layout } from "$lib/layout.svelte";

  let notOpen = $derived(workspace.recent.filter((path) => !isOpen(path)));

  /** Projects whose sessions from outside the app are unfolded. */
  let unfolded = $state<Record<string, boolean>>({});

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
    const out: Row[] = [];
    for (const project of workspace.open) {
      const path = project.path;
      out.push({ id: `project:${path}`, run: () => activate(path) });
      for (const session of forProject(path)) {
        out.push({ id: `session:${session.key}`, run: () => choose(session.key) });
      }
      if (workspace.active !== path) continue;
      for (const transcript of historyFor(path)) {
        out.push({ id: `past:${transcript.id}`, run: () => resume(path, transcript.id) });
      }
      if (isReady()) out.push({ id: `new:${path}`, run: () => start(path) });
      if (outsideFor(path).length > 0) {
        out.push({ id: `fold:${path}`, run: () => (unfolded[path] = !unfolded[path]) });
        if (unfolded[path]) {
          for (const transcript of outsideFor(path)) {
            out.push({ id: `outside:${transcript.id}`, run: () => resume(path, transcript.id) });
          }
        }
      }
      if (!hook.busy) out.push({ id: `hook:${path}`, run: () => toggle(path) });
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
    return rows[0]?.id ?? null;
  });

  // Focusing the pane by key puts the keyboard here, so the arrows work at
  // once, and starts the cursor over from the session you are in rather than
  // from whatever a click left it on. A click inside already has the keyboard.
  $effect(() => {
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

  function resume(path: string, id: string) {
    create(path, id);
    focusPane("agent");
  }

  function start(path: string) {
    create(path);
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
      case "Enter":
      case " ":
        if (at === -1) return;
        rows[at].run();
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
      if (!isKnown(project.path)) check(project.path);
    }
  });

  function isOpen(path: string) {
    return workspace.open.some((project) => project.path === path);
  }

  function shorten(path: string) {
    const home = path.match(/^\/(?:Users|home)\/[^/]+/);
    return home ? `~${path.slice(home[0].length)}` : path;
  }
</script>

<Pane id="sessions" title="Projects &amp; sessions" meta="">
  <div class="head">
    <button onclick={pick} disabled={workspace.opening} data-testid="open-project">
      Open project
    </button>
  </div>

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
            <span class="dot" class:live={isLive(session)}></span>
            <span class="label">{label(session)}</span>
            <span class="state">{statusLabel(session)}</span>
          </button>
          <button
            class="icon"
            tabindex="-1"
            onclick={() => closeSession(session.key)}
            aria-label="Close {label(session)}"
            data-testid="close-session">×</button
          >
        </div>
      {/each}

      {#if workspace.active === project.path}
        {#each historyFor(project.path) as transcript (transcript.id)}
          <button
            class="row past"
            class:cursor={current === `past:${transcript.id}`}
            tabindex="-1"
            onclick={() => resume(project.path, transcript.id)}
            disabled={!isReady()}
            title={transcript.title ?? transcript.id}
            data-row="past:{transcript.id}"
            data-testid="past-session"
          >
            <span class="dot"></span>
            <span class="label">{historyLabel(transcript)}</span>
            <span class="state">{ago(transcript.modified)}</span>
          </button>
        {/each}

        <button
          class="new"
          class:cursor={current === `new:${project.path}`}
          tabindex="-1"
          onclick={() => start(project.path)}
          disabled={!isReady()}
          data-row="new:{project.path}"
          data-testid="new-session">+ New session</button
        >

        <!-- Claude Code run in a plain terminal here leaves transcripts in
             the same place. They are resumable, so they are here, folded,
             rather than mixed in with what this window started. -->
        {#if outsideFor(project.path).length > 0}
          {@const outside = outsideFor(project.path)}
          <button
            class="fold"
            class:cursor={current === `fold:${project.path}`}
            tabindex="-1"
            onclick={() => (unfolded[project.path] = !unfolded[project.path])}
            aria-expanded={Boolean(unfolded[project.path])}
            data-row="fold:{project.path}"
            data-testid="outside-fold"
          >
            <span class="chevron" class:open={unfolded[project.path]}>▸</span>
            {outside.length} from outside the workbench
          </button>
          {#if unfolded[project.path]}
            {#each outside as transcript (transcript.id)}
              <button
                class="row past outside"
                class:cursor={current === `outside:${transcript.id}`}
                tabindex="-1"
                onclick={() => resume(project.path, transcript.id)}
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

        <!-- Off by default: it writes into the project's settings.local.json,
             and the watcher already covers the same ground. What it adds is
             hearing from the agent the moment a tool finishes. -->
        <button
          class="hook"
          class:on={isInstalled(project.path)}
          class:cursor={current === `hook:${project.path}`}
          tabindex="-1"
          onclick={() => toggle(project.path)}
          disabled={hook.busy}
          data-row="hook:{project.path}"
          title={isInstalled(project.path)
            ? "The agent reports edits directly. Click to remove the hook."
            : "Add a PostToolUse hook so edits are reported the moment a tool finishes."}
          data-testid="hook-toggle"
        >
          {isInstalled(project.path) ? "live updates: hook" : "live updates: filesystem"}
        </button>
        {#if hook.error}
          <p class="error" data-testid="hook-error">{hook.error}</p>
        {/if}
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
    padding: 8px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  .head button {
    width: 100%;
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
    display: flex;
    align-items: center;
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
    background: var(--accent-soft);
  }

  .session.on .label {
    color: var(--accent);
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state {
    font-size: 10px;
    color: var(--ink-3);
    flex: none;
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
    margin: 0 0 4px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--pane-pad) 2px 26px;
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

  .hook {
    display: block;
    width: 100%;
    text-align: left;
    margin: 0 0 10px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--pane-pad) 2px 26px;
  }

  .hook.on {
    color: var(--accent);
  }

  .hook:disabled {
    opacity: 0.5;
    cursor: default;
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

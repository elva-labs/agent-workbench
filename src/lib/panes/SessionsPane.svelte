<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import { isReady } from "$lib/agent.svelte";
  import {
    ago,
    close as closeSession,
    create,
    forProject,
    historyFor,
    historyLabel,
    isLive,
    label,
    loadHistory,
    select,
    sessions,
    statusLabel,
  } from "$lib/sessions.svelte";
  import { activate, close as closeProject, openPath, pick, workspace } from "$lib/workspace.svelte";
  import { check, hook, isInstalled, isKnown, toggle } from "$lib/hook.svelte";

  let notOpen = $derived(workspace.recent.filter((path) => !isOpen(path)));

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

  <div class="tree">
    {#each workspace.open as project (project.path)}
      {@const own = forProject(project.path)}
      <div class="project" class:on={workspace.active === project.path}>
        <button class="row project-row" onclick={() => activate(project.path)} title={project.path}>
          <span class="name">{project.name}</span>
          {#if !project.isGit}<span class="flag" title="Not a git repository">no git</span>{/if}
        </button>
        <button
          class="icon"
          onclick={() => closeProject(project.path)}
          aria-label="Close {project.name}"
          data-testid="close-project">×</button
        >
      </div>

      {#each own as session (session.key)}
        <div class="session" class:on={sessions.active === session.key}>
          <button class="row" onclick={() => select(session.key)} data-testid="session-row">
            <span class="dot" class:live={isLive(session)}></span>
            <span class="label">{label(session)}</span>
            <span class="state">{statusLabel(session)}</span>
          </button>
          <button
            class="icon"
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
            onclick={() => create(project.path, transcript.id)}
            disabled={!isReady()}
            title={transcript.title ?? transcript.id}
            data-testid="past-session"
          >
            <span class="dot"></span>
            <span class="label">{historyLabel(transcript)}</span>
            <span class="state">{ago(transcript.modified)}</span>
          </button>
        {/each}

        <button
          class="new"
          onclick={() => create(project.path)}
          disabled={!isReady()}
          data-testid="new-session">+ New session</button
        >

        <!-- Off by default: it writes into the project's settings.local.json,
             and the watcher already covers the same ground. What it adds is
             hearing from the agent the moment a tool finishes. -->
        <button
          class="hook"
          class:on={isInstalled(project.path)}
          onclick={() => toggle(project.path)}
          disabled={hook.busy}
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
          <button onclick={() => openPath(path)} title={path}>{shorten(path)}</button>
        </li>
      {/each}
    </ul>
  {/if}
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

  .tree {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
    min-height: 0;
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
    margin: 2px 0 10px 26px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 0;
  }

  .new:hover:not(:disabled) {
    color: var(--accent);
  }

  .new:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .hook {
    display: block;
    margin: 0 0 10px 26px;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 0;
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

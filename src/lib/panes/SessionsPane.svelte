<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import { agent } from "$lib/agent.svelte";
  import { openPath, pick, project, projectName } from "$lib/project.svelte";

  // Phase 3 fills the space below the header with the real session index read
  // from ~/.claude/projects. Until then the recent list is what there is.
  let confirming = $state(false);

  function requestOpen() {
    // Switching project leaves the agent in the wrong directory, so the
    // running session has to go. That is worth asking about: you may be
    // halfway through something.
    if (agent.status === "running" || agent.status === "starting") confirming = true;
    else pick();
  }

  function confirmed() {
    confirming = false;
    pick();
  }

  function shorten(path: string) {
    const home = path.match(/^\/(?:Users|home)\/[^/]+/);
    return home ? `~${path.slice(home[0].length)}` : path;
  }
</script>

<Pane id="sessions" title="Projects &amp; sessions" meta={project.current?.isGit ? "git" : ""}>
  <div class="head">
    <span class="name" title={project.current?.path ?? ""}>{projectName()}</span>
    <button onclick={requestOpen} disabled={project.opening} data-testid="open-project">Open</button>
  </div>

  {#if confirming}
    <div class="confirm" data-testid="switch-confirm">
      <p>Opening another project stops the running agent.</p>
      <div class="actions">
        <button onclick={confirmed} data-testid="confirm-switch">Switch</button>
        <button class="quiet" onclick={() => (confirming = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if project.error}
    <p class="error" data-testid="project-error">{project.error}</p>
  {/if}

  {#if project.current === null}
    <div class="empty" data-testid="no-project">
      <p>Open a folder to work in. The agent starts there and the changes pane watches it.</p>
    </div>
  {:else if !project.current.isGit}
    <p class="note" data-testid="not-a-repo">
      Not a git repository, so there are no changes to show on the right.
    </p>
  {/if}

  {#if project.recent.length > 0}
    <p class="label">Recent</p>
    <ul class="recent">
      {#each project.recent as path (path)}
        <li>
          <button
            class:on={project.current?.path === path}
            onclick={() => openPath(path)}
            title={path}
          >
            {shorten(path)}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Pane>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  .name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head button {
    margin-left: auto;
    flex: none;
  }

  button {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .quiet {
    border-color: var(--rule);
    background: var(--surface);
    color: var(--ink-3);
  }

  .confirm {
    padding: 10px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    background: var(--surface-2);
    flex: none;
  }

  .confirm p {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--ink-2);
  }

  .actions {
    display: flex;
    gap: 6px;
  }

  .empty p,
  .note,
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

  .label {
    margin: 0;
    padding: 12px var(--pane-pad) 4px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .recent {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 0 8px;
  }

  .recent button {
    display: block;
    width: 100%;
    text-align: left;
    text-transform: none;
    letter-spacing: 0;
    font-size: 11.5px;
    padding: 4px var(--pane-pad);
    border: 0;
    background: none;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent button:hover {
    background: var(--surface-2);
  }

  .recent button.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
</style>

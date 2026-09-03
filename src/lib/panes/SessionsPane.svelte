<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";

  // Placeholder shape only. Phase 3 replaces this with the session index the
  // Rust core builds from transcript filenames and stat data.
  const projects = [
    {
      name: "coretura-platform",
      open: true,
      sessions: [
        { title: "auth-refactor", age: "2m", active: true },
        { title: "fix-cdk-drift", age: "4h", active: false },
        { title: "untitled", age: "1d", active: false, untitled: true },
      ],
    },
    { name: "hass-mcp-server", open: false, sessions: [] },
  ];
</script>

<Pane id="sessions" title="Projects &amp; sessions">
  <ul class="tree no-select">
    {#each projects as project (project.name)}
      <li class="project">
        <span class="chev">{project.open ? "▾" : "▸"}</span>{project.name}
      </li>
      {#each project.sessions as session (session.title + session.age)}
        <li class="session" class:active={session.active} class:untitled={session.untitled}>
          <span class="label">{session.title}</span>
          <span class="age">{session.age}</span>
        </li>
      {/each}
    {/each}
  </ul>
</Pane>

<style>
  .tree {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 8px 0;
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .project {
    padding: 5px var(--pane-pad);
    color: var(--ink-2);
  }

  .chev {
    display: inline-block;
    width: 14px;
    color: var(--ink-3);
  }

  .session {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 4px var(--pane-pad) 4px 26px;
    color: var(--ink-2);
  }

  .session.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .session.untitled .label {
    color: var(--ink-3);
    font-style: italic;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .age {
    color: var(--ink-3);
    flex: none;
  }
</style>

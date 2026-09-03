<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import FileTree from "$lib/components/FileTree.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import { onMount, untrack } from "svelte";
  import {
    canDiff,
    clear,
    files,
    listed,
    refresh,
    select,
    selectedEntry,
    setScope,
    setView,
  } from "$lib/files.svelte";
  import { core } from "$lib/core";
  import { isInstalled } from "$lib/hook.svelte";
  import { activeProject, watchRoot, workspace } from "$lib/workspace.svelte";
  import { DEFAULT, MIN, applyLayout, enterReview, exitReview, layout, saveLayout } from "$lib/layout.svelte";

  let entries = $derived(listed());
  let reviewing = $derived(layout.mode === "reviewing");
  let diffable = $derived(canDiff(selectedEntry()));
  let root = $derived(watchRoot());
  let notGit = $derived(activeProject() !== null && root === null);

  onMount(() => {
    let off: (() => void) | null = null;
    // The agent edits a file and the pane reacts without being asked. The core
    // does not say what changed, only that something did: re-reading status is
    // cheap, and being right beats diffing two states.
    core()
      .onGitChanged(() => refresh())
      .then((unlisten) => (off = unlisten));
    return () => off?.();
  });

  // A new project means a different worktree to watch and a tree that shares
  // nothing with the old one.
  $effect(() => {
    const watching = root;
    untrack(() => {
      clear();
      if (watching === null) return;
      watch(watching);
      refresh();
    });
  });

  // Installing the hook creates the file it writes to, and the watcher only
  // attaches to a file that exists, so it is asked again once that is true.
  $effect(() => {
    const watching = root;
    const hooked = isInstalled(workspace.active);
    untrack(() => {
      if (hooked && watching !== null) watch(watching);
    });
  });

  // A watch that could not start is worth saying: the tree still loads, but it
  // will not follow the agent.
  function watch(watching: string) {
    core()
      .gitWatch(watching)
      .catch((error) => (files.error = `Not watching for changes: ${String(error)}`));
  }

  function open(path: string) {
    select(path);
    enterReview();
  }

  function resizeTree(dx: number) {
    layout.tree = Math.max(MIN.tree, layout.tree + dx);
    applyLayout(layout.width);
  }

  function resetTree() {
    layout.tree = DEFAULT.tree;
    applyLayout(layout.width);
    saveLayout();
  }
</script>

<Pane id="changes" title="Changes" meta="{entries.length} files">
  <!-- Scope and view are one control surface: widening the scope is what puts
       files in the list that have no diff, so the two belong side by side. -->
  <div class="head">
    <div class="seg" role="group" aria-label="Which files to list">
      <button class:on={files.scope === "changed"} onclick={() => setScope("changed")}>
        Changed
      </button>
      <button class:on={files.scope === "all"} onclick={() => setScope("all")}>All files</button>
    </div>

    <div class="seg" role="group" aria-label="How to show the file">
      <button
        class:on={files.view === "diff" && diffable}
        disabled={!diffable}
        title={diffable ? "" : "This file has no changes to diff"}
        onclick={() => setView("diff")}
      >
        Diff
      </button>
      <button
        class:on={files.view === "content" || !diffable}
        disabled={files.selected === null}
        onclick={() => setView("content")}
      >
        Content
      </button>
    </div>

    {#if reviewing}
      <button class="close" onclick={exitReview} aria-label="Close the viewer">Esc</button>
    {/if}
  </div>

  {#if files.error}
    <p class="notice error" data-testid="changes-error">{files.error}</p>
  {/if}

  {#if notGit}
    <p class="notice" data-testid="not-git">
      This folder is not a git repository, so there are no changes to show. Sessions still run in it.
    </p>
  {/if}

  <!-- The tree is the same component in both shapes. Working, it has the pane
       to itself; reviewing, it becomes the left column and keeps its scroll
       position, its open folders and its selection. -->
  <div class="split" class:reviewing style:--tree-w="{layout.tree}px">
    <FileTree onOpen={open} />
    {#if reviewing}
      <Splitter label="Resize the file tree" onDelta={resizeTree} onReset={resetTree} onCommit={saveLayout} />
      <FileViewer />
    {/if}
  </div>
</Pane>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  .seg {
    display: flex;
    gap: 1px;
  }

  .seg button,
  .close {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 9px;
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--ink-3);
    cursor: pointer;
  }

  .seg button.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .seg button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .close {
    margin-left: auto;
  }

  .close:hover {
    border-color: var(--rule-strong);
    color: var(--ink-2);
  }

  .notice {
    margin: 0;
    padding: 10px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-3);
    flex: none;
  }

  .notice.error {
    color: var(--del);
  }

  .split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr;
  }

  .split.reviewing {
    grid-template-columns: var(--tree-w) var(--splitter-w) 1fr;
  }
</style>

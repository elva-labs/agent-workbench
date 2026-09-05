<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import FileTree from "$lib/components/FileTree.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import SearchResults from "$lib/components/SearchResults.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import { onMount, untrack } from "svelte";
  import {
    canDiff,
    clear,
    clearQuery,
    closeViewer,
    files,
    listed,
    openAt,
    refresh,
    search,
    searchingLines,
    select,
    selectedEntry,
    setMode,
    setQuery,
    setScope,
    setView,
    visible,
  } from "$lib/files.svelte";
  import { core } from "$lib/core";
  import { isInstalled } from "$lib/hook.svelte";
  import { activeProject, followedWorktree, watchRoot, workspace } from "$lib/workspace.svelte";
  import { DEFAULT, MIN, applyLayout, enterReview, layout, saveLayout } from "$lib/layout.svelte";

  let entries = $derived(listed());
  let reviewing = $derived(layout.mode === "reviewing");
  let diffable = $derived(canDiff(selectedEntry()));
  let root = $derived(watchRoot());
  let worktree = $derived(followedWorktree());
  let notGit = $derived(activeProject() !== null && root === null);

  let field: HTMLInputElement;
  let menuOpen = $state(false);

  // A chord asked for the field: put the keyboard in it, whatever had it.
  $effect(() => {
    files.fieldRequests;
    if (files.fieldRequests > 0 && field) {
      field.focus();
      field.select();
    }
  });

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // Once to clear, once more to leave, as the field's own convention.
      e.stopPropagation();
      if (files.query !== "") clearQuery();
      else field.blur();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (files.mode === "lines") void search();
      else {
        const first = visible()[0];
        if (first !== undefined) open(first.path);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      // Down leaves the field for what it found.
      e.preventDefault();
      const next = field.closest("section")?.querySelector<HTMLElement>(
        "[data-testid='file-tree'], [data-testid='search-results'] button.hit",
      );
      next?.focus();
    }
  }

  function openHit(path: string, line: number) {
    void openAt(path, line);
    enterReview();
  }

  function choose(run: () => void) {
    run();
    menuOpen = false;
  }

  function onMenuKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      menuOpen = false;
    }
  }

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

<Pane
  id="changes"
  title="Changes"
  meta={worktree === null ? `${entries.length} files` : `worktree ${worktree} · ${entries.length} files`}
>
  <!-- The field is the toolbar: what you type narrows the tree, or searches
       inside the files. Scope and view moved into the menu at the end, with
       their chords beside them. -->
  <div class="head">
    <label class="field" class:lines={files.mode === "lines"}>
      <span class="glyph" aria-hidden="true">⌕</span>
      <input
        type="search"
        bind:this={field}
        value={files.query}
        oninput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        onkeydown={onFieldKeydown}
        placeholder={files.mode === "lines" ? "search in files…" : "filter files…"}
        aria-label={files.mode === "lines" ? "Search in files" : "Filter files"}
        spellcheck="false"
        autocomplete="off"
        data-testid="search-field"
      />
      <span class="modes" role="radiogroup" aria-label="What to search">
        <button
          role="radio"
          aria-checked={files.mode === "files"}
          class:on={files.mode === "files"}
          onclick={() => setMode("files")}
          title="Narrow the tree to paths holding the text ({describe(chordFor('find'))})"
          data-testid="mode-files">files</button
        >
        <button
          role="radio"
          aria-checked={files.mode === "lines"}
          class:on={files.mode === "lines"}
          onclick={() => setMode("lines")}
          title="Search inside the files ({describe(chordFor('findLines'))})"
          data-testid="mode-lines">lines</button
        >
      </span>
    </label>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="more" onkeydown={onMenuKeydown}>
      <button
        class="tool"
        onclick={() => (menuOpen = !menuOpen)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More"
        data-testid="changes-menu">⋯</button
      >
      {#if menuOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="scrim" onclick={() => (menuOpen = false)}></div>
        <div class="menu" role="menu" data-testid="changes-menu-items">
          <button
            role="menuitemradio"
            aria-checked={files.scope === "changed"}
            onclick={() => choose(() => setScope("changed"))}
            data-testid="menu-scope-changed"
          >
            <span>Changed files</span><kbd>{describe(chordFor("scope"))}</kbd>
          </button>
          <button
            role="menuitemradio"
            aria-checked={files.scope === "all"}
            onclick={() => choose(() => setScope("all"))}
            data-testid="menu-scope-all"
          >
            <span>All files</span><kbd>{describe(chordFor("scope"))}</kbd>
          </button>
          <hr />
          <button
            role="menuitemradio"
            aria-checked={files.view === "diff" && diffable}
            disabled={!diffable}
            onclick={() => choose(() => setView("diff"))}
            data-testid="menu-view-diff"
          >
            <span>Diff</span><kbd>{describe(chordFor("view"))}</kbd>
          </button>
          <button
            role="menuitemradio"
            aria-checked={files.view === "content" || !diffable}
            disabled={files.selected === null}
            onclick={() => choose(() => setView("content"))}
            data-testid="menu-view-content"
          >
            <span>Whole file</span><kbd>{describe(chordFor("view"))}</kbd>
          </button>
          <hr />
          <button role="menuitem" onclick={() => choose(() => refresh())} data-testid="menu-reload">
            <span>Reload</span>
          </button>
        </div>
      {/if}
    </div>
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
    {#if searchingLines()}
      <SearchResults onOpen={openHit} />
    {:else}
      <FileTree onOpen={open} onBlank={closeViewer} focused={layout.focus === "changes"} />
    {/if}
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

  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 8px;
    border: 1px solid var(--rule);
    background: var(--surface-2);
  }

  .field:focus-within {
    border-color: var(--accent);
  }

  .field.lines {
    background: var(--accent-soft);
  }

  .glyph {
    flex: none;
    color: var(--ink-3);
    font-size: 12px;
  }

  .field input {
    flex: 1;
    min-width: 0;
    padding: 4px 0;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
    outline: none;
  }

  .field input::placeholder {
    color: var(--ink-3);
  }

  .field input::-webkit-search-cancel-button {
    display: none;
  }

  .modes {
    flex: none;
    display: inline-flex;
    gap: 2px;
  }

  .modes button,
  .tool {
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 5px;
  }

  .modes button.on {
    color: var(--accent);
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 1px 4px;
  }

  .modes button:hover:not(.on),
  .tool:hover {
    color: var(--ink);
  }

  .tool {
    font-size: 14px;
    line-height: 1;
    padding: 2px 6px;
  }

  .more {
    position: relative;
    flex: none;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 4;
  }

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 232px;
    padding: 4px 0;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    box-shadow: 0 8px 24px color-mix(in srgb, black 25%, transparent);
  }

  .menu hr {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 4px 0;
  }

  .menu button {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 5px var(--pane-pad) 5px 24px;
    border: 0;
    background: none;
    font-size: 12.5px;
    color: var(--ink-2);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    position: relative;
  }

  .menu button[aria-checked="true"]::before {
    content: "•";
    position: absolute;
    left: 10px;
    color: var(--accent);
  }

  .menu button:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  .menu button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .menu kbd {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
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

<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import FileTree, { type Beyond } from "$lib/components/FileTree.svelte";
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
  import { listed as presentedFor, openItem } from "$lib/media.svelte";
  import { elapsed, processes, stop as stopProcess, type ProcessRow } from "$lib/processes.svelte";
  import {
    askFor,
    listed as listedSections,
    noticeOf,
    run as runAction,
    type PluginSection,
  } from "$lib/pluginSections.svelte";
  import type { PluginAction, PluginRow } from "$lib/core";
  import { lastSegment } from "$lib/paths";
  import { ago } from "$lib/sessions.svelte";
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
  let presented = $derived(presentedFor());
  /** The tree's column, for turning a drag into a share of it. */
  let columnHeight = $state(0);

  /** The sections' rows as the tree's cursor sees them: each section's
      header, then its rows while it is open, media first, processes after. */
  let sectionCursor = $state(-1);
  const FOLD_ID = "media-fold";
  const PROCESSES_FOLD_ID = "processes-fold";
  const rowIdOf = (id: string) => `media-${id}`;
  const processRowId = (row: ProcessRow) => `process-${row.pid}`;
  const pluginFoldId = (key: string) => `plugin-fold-${key}`;
  const pluginRowId = (key: string, row: PluginRow) => `plugin-row-${key}-${row.id}`;
  type Entry =
    | { id: string; kind: "media-head" }
    | { id: string; kind: "media"; index: number }
    | { id: string; kind: "processes-head" }
    | { id: string; kind: "process"; index: number }
    | { id: string; kind: "plugin-head"; key: string }
    | { id: string; kind: "plugin-row"; key: string; index: number };
  let pluginList = $derived(listedSections());
  let sectionEntries: Entry[] = $derived.by(() => {
    const list: Entry[] = [];
    if (presented.length > 0) {
      list.push({ id: FOLD_ID, kind: "media-head" });
      if (layout.mediaOpen) {
        presented.forEach((item, index) => list.push({ id: rowIdOf(item.id), kind: "media", index }));
      }
    }
    list.push({ id: PROCESSES_FOLD_ID, kind: "processes-head" });
    if (layout.processesOpen) {
      processes.rows.forEach((row, index) => list.push({ id: processRowId(row), kind: "process", index }));
    }
    for (const section of pluginList) {
      list.push({ id: pluginFoldId(section.key), kind: "plugin-head", key: section.key });
      if (sectionOpen(section.key)) {
        section.rows.forEach((row, index) =>
          list.push({ id: pluginRowId(section.key, row), kind: "plugin-row", key: section.key, index }),
        );
      }
    }
    return list;
  });
  let cursorId = $derived(sectionEntries[sectionCursor]?.id ?? null);
  let beyond: Beyond = $derived({
    ids: sectionEntries.map((entry) => entry.id),
    cursor: sectionCursor,
    onCursor: (index) => (sectionCursor = index),
    activate: (index) => {
      const entry = sectionEntries[index];
      if (entry === undefined) return;
      if (entry.kind === "media-head") toggleMedia();
      else if (entry.kind === "media") openItem(presented[entry.index]);
      else if (entry.kind === "processes-head") toggleProcesses();
      else if (entry.kind === "plugin-head") toggleSection(entry.key);
      else if (entry.kind === "plugin-row") {
        const section = pluginList.find((candidate) => candidate.key === entry.key);
        if (section !== undefined) runDefault(section, section.rows[entry.index]);
      }
    },
    fold: (index, open) => {
      const entry = sectionEntries[index];
      if (entry === undefined) return;
      if (entry.kind === "plugin-head" || entry.kind === "plugin-row") {
        if (open === sectionOpen(entry.key)) return;
        const head = sectionEntries.findIndex(
          (candidate) => candidate.kind === "plugin-head" && candidate.key === entry.key,
        );
        setSectionOpen(entry.key, open);
        if (!open) sectionCursor = head;
        return;
      }
      const media = entry.kind === "media-head" || entry.kind === "media";
      const head = sectionEntries.findIndex((candidate) => candidate.kind === (media ? "media-head" : "processes-head"));
      if (media) {
        if (open === layout.mediaOpen) return;
        layout.mediaOpen = open;
      } else {
        if (open === layout.processesOpen) return;
        layout.processesOpen = open;
      }
      saveLayout();
      // Folding from a row leaves the cursor on the section's header.
      if (!open) sectionCursor = head;
    },
  });

  // What the agent presents opens by itself: the cursor follows it onto
  // its row while the section is open, so Escape lands the keyboard there.
  $effect(() => {
    const open = files.media;
    if (open === null) return;
    const at = sectionEntries.findIndex((entry) => entry.kind === "media" && presented[entry.index]?.id === open.id);
    if (at !== -1) sectionCursor = at;
  });

  let anyOpen = $derived(
    (presented.length > 0 && layout.mediaOpen) ||
      layout.processesOpen ||
      pluginList.some((section) => sectionOpen(section.key)),
  );

  /** A plugin's section is folded until it is asked for, and the answer is
      remembered by its key. */
  function sectionOpen(key: string) {
    return layout.sectionsOpen[key] === true;
  }

  function setSectionOpen(key: string, open: boolean) {
    layout.sectionsOpen[key] = open;
    saveLayout();
  }

  function toggleSection(key: string) {
    setSectionOpen(key, !sectionOpen(key));
  }

  /** An action with fields to fill in is asked about first; the rest run. */
  function act(section: PluginSection, action: PluginAction, row: string | null) {
    if (action.input !== null && action.input.length > 0) askFor(section, action, row);
    else void runAction(section, action, row);
  }

  function runDefault(section: PluginSection, row: PluginRow | undefined) {
    if (row === undefined || row.default === null) return;
    const action = row.actions?.find((candidate) => candidate.id === row.default);
    if (action !== undefined) act(section, action, row.id);
  }

  function resizeMedia(dy: number) {
    if (columnHeight === 0) return;
    const share = layout.mediaShare - dy / columnHeight;
    layout.mediaShare = Math.max(0.12, Math.min(0.8, share));
  }

  function resetMedia() {
    layout.mediaShare = 0.3;
    saveLayout();
  }

  function toggleMedia() {
    layout.mediaOpen = !layout.mediaOpen;
    saveLayout();
  }

  function toggleProcesses() {
    layout.processesOpen = !layout.processesOpen;
    saveLayout();
  }

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
    <!-- The tree's column: the tree, and beneath it what the agent
         presented for the session on screen, a section of its own with a
         divider to drag, folded to its header when asked. -->
    <div class="column" bind:clientHeight={columnHeight}>
      <div class="tree-slot">
        {#if searchingLines()}
          <SearchResults onOpen={openHit} />
        {:else}
          <FileTree onOpen={open} onBlank={closeViewer} focused={layout.focus === "changes"} {beyond} />
        {/if}
      </div>
      {#if anyOpen}
        <Splitter
          label="Resize the sections under the tree"
          orientation="horizontal"
          onDelta={resizeMedia}
          onReset={resetMedia}
          onCommit={saveLayout}
        />
      {/if}
      <!-- The rows here are the tree's cursor's to walk, so a click keeps
           the keyboard on the tree rather than moving it to the row, and
           Tab does not stop on each of them. Two sections share the
           height when both are open. -->
      <div
        class="sections"
        class:open={anyOpen}
        class:keyed={layout.focus === "changes"}
        style:--sections-h="{Math.round(layout.mediaShare * 100)}%"
        data-testid="sections"
      >
        {#if presented.length > 0}
          <section class="section" class:open={layout.mediaOpen} data-testid="media-section">
            <button
              id={FOLD_ID}
              class="fold"
              class:cursor={cursorId === FOLD_ID}
              tabindex="-1"
              onpointerdown={(e) => e.preventDefault()}
              onclick={() => {
                sectionCursor = sectionEntries.findIndex((entry) => entry.kind === "media-head");
                toggleMedia();
              }}
              aria-expanded={layout.mediaOpen}
              data-testid="media-fold"
            >
              <span class="chevron">{layout.mediaOpen ? "▾" : "▸"}</span>
              Media ({presented.length})
            </button>
            {#if layout.mediaOpen}
              <ul class="rows">
                {#each presented as item (item.id)}
                  <li>
                    <button
                      id={rowIdOf(item.id)}
                      class="media-row"
                      class:on={files.media?.id === item.id}
                      class:cursor={cursorId === rowIdOf(item.id)}
                      tabindex="-1"
                      onpointerdown={(e) => e.preventDefault()}
                      onclick={() => {
                        sectionCursor = sectionEntries.findIndex((entry) => entry.id === rowIdOf(item.id));
                        openItem(item);
                      }}
                      title={item.files.join("\n")}
                      data-testid="media-item"
                    >
                      <span class="media-caption">{item.caption ?? lastSegment(item.files[0])}</span>
                      <span class="media-meta"
                        >{item.files.length === 1 ? lastSegment(item.files[0]) : `${item.files.length} files`} · {ago(item.at)}</span
                      >
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
        <section class="section" class:open={layout.processesOpen} data-testid="processes-section">
          <button
            id={PROCESSES_FOLD_ID}
            class="fold"
            class:cursor={cursorId === PROCESSES_FOLD_ID}
            tabindex="-1"
            onpointerdown={(e) => e.preventDefault()}
            onclick={() => {
              sectionCursor = sectionEntries.findIndex((entry) => entry.kind === "processes-head");
              toggleProcesses();
            }}
            aria-expanded={layout.processesOpen}
            data-testid="processes-fold"
          >
            <span class="chevron">{layout.processesOpen ? "▾" : "▸"}</span>
            Processes{processes.rows.length > 0 ? ` (${processes.rows.length})` : ""}
          </button>
          {#if layout.processesOpen}
            {#if processes.rows.length === 0}
              <p class="section-empty" data-testid="processes-empty">Nothing running under the sessions.</p>
            {:else}
              <ul class="rows">
                {#each processes.rows as row (`${row.ptyId}:${row.pid}`)}
                  <li class="process" class:cursor={cursorId === processRowId(row)} id={processRowId(row)} data-testid="process-row">
                    <button
                      class="media-row"
                      tabindex="-1"
                      onpointerdown={(e) => e.preventDefault()}
                      onclick={() => (sectionCursor = sectionEntries.findIndex((entry) => entry.id === processRowId(row)))}
                      title={row.command}
                    >
                      <span class="media-caption">{row.command || row.name}</span>
                      <span class="media-meta"
                        >{row.owner} · {elapsed(row.started)} · {Math.round(row.cpu)}% · {Math.round(row.memory / 1048576)} MB</span
                      >
                    </button>
                    <button
                      class="stop"
                      tabindex="-1"
                      onpointerdown={(e) => e.preventDefault()}
                      onclick={() => void stopProcess(row)}
                      aria-label="Stop {row.name}"
                      title="Stop"
                      data-testid="process-stop">×</button
                    >
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </section>
        <!-- A plugin's section: the same shape, with the rows and the
             actions the plugin sent for the project on screen. -->
        {#each pluginList as section (section.key)}
          {@const open = sectionOpen(section.key)}
          {@const notice = noticeOf(section)}
          <section class="section" class:open data-section={section.key} data-testid="plugin-section">
            <div class="section-head">
              <button
                id={pluginFoldId(section.key)}
                class="fold"
                class:cursor={cursorId === pluginFoldId(section.key)}
                tabindex="-1"
                onpointerdown={(e) => e.preventDefault()}
                onclick={() => {
                  sectionCursor = sectionEntries.findIndex(
                    (entry) => entry.kind === "plugin-head" && entry.key === section.key,
                  );
                  toggleSection(section.key);
                }}
                aria-expanded={open}
                data-testid="plugin-fold"
              >
                <span class="chevron">{open ? "▾" : "▸"}</span>
                {section.title}{section.rows.length > 0 ? ` (${section.rows.length})` : ""}
              </button>
              <span class="head-actions">
                {#each section.actions as action (action.id)}
                  <button
                    class="head-action"
                    tabindex="-1"
                    onpointerdown={(e) => e.preventDefault()}
                    onclick={() => act(section, action, null)}
                    data-action={action.id}
                    data-testid="plugin-section-action">{action.label}</button
                  >
                {/each}
              </span>
            </div>
            {#if notice !== null}
              <p class="section-notice" data-testid="plugin-notice">{notice}</p>
            {/if}
            {#if open}
              <ul class="rows">
                {#each section.rows as row (row.id)}
                  <li
                    id={pluginRowId(section.key, row)}
                    class="plugin"
                    class:cursor={cursorId === pluginRowId(section.key, row)}
                    data-row={row.id}
                    data-testid="plugin-row"
                  >
                    <button
                      class="media-row"
                      tabindex="-1"
                      onpointerdown={(e) => e.preventDefault()}
                      onclick={() => {
                        sectionCursor = sectionEntries.findIndex(
                          (entry) => entry.id === pluginRowId(section.key, row),
                        );
                        runDefault(section, row);
                      }}
                      title={row.detail ?? row.label}
                    >
                      <span class="row-line">
                        <span class="dot" data-state={row.state ?? "none"}></span>
                        <span class="media-caption">{row.label}</span>
                      </span>
                      {#if row.detail !== null}
                        <span class="media-meta">{row.detail}</span>
                      {/if}
                    </button>
                    <span class="row-actions">
                      {#each row.actions ?? [] as action (action.id)}
                        <button
                          class="row-action"
                          tabindex="-1"
                          onpointerdown={(e) => e.preventDefault()}
                          onclick={() => act(section, action, row.id)}
                          data-action={action.id}
                          data-testid="plugin-row-action">{action.label}</button
                        >
                      {/each}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    </div>
    {#if reviewing}
      <Splitter label="Resize the file tree" onDelta={resizeTree} onReset={resetTree} onCommit={saveLayout} />
      <FileViewer />
    {/if}
  </div>
</Pane>

<style>
  .column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .tree-slot {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .sections {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--rule);
  }

  .sections.open {
    flex: 0 0 var(--sections-h);
  }

  .section {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .section + .section {
    border-top: 1px solid var(--rule);
  }

  .section.open {
    flex: 1 1 0;
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    flex: none;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 6px var(--pane-pad);
  }

  .fold:hover {
    color: var(--ink);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0 0 6px;
    overflow: auto;
    min-height: 0;
  }

  .section-empty {
    margin: 0;
    padding: 2px var(--pane-pad) 8px 26px;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  /* A process row: the text, and a stop button over its end on hover. A
     plugin's row carries its actions the same way. */
  .process,
  .plugin {
    position: relative;
  }

  .stop,
  .row-actions {
    position: absolute;
    top: 0;
    right: 6px;
    bottom: 0;
    opacity: 0;
  }

  .stop {
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 13px;
    padding: 0 6px;
    cursor: pointer;
  }

  .process:hover .stop,
  .process.cursor .stop,
  .plugin:hover .row-actions,
  .plugin.cursor .row-actions {
    opacity: 1;
  }

  .stop:hover {
    color: var(--del);
  }

  /* A section a plugin sent: its header carries the plugin's own actions,
     and a word from it sits under the header until it goes. */
  .section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .section-head .fold {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .head-actions,
  .row-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .head-actions {
    flex: none;
    padding-right: 6px;
  }

  .head-action,
  .row-action {
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 5px;
    white-space: nowrap;
  }

  .head-action:hover,
  .row-action:hover {
    color: var(--accent);
    background: var(--surface-2);
  }

  .section-notice {
    margin: 0;
    padding: 0 var(--pane-pad) 6px 26px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--del);
  }

  .row-line {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
  }

  /* The row's state, drawn as a session's is: filled while something is
     happening, hollow when the plugin said nothing. */
  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border: 1px solid var(--ink-3);
    border-radius: 50%;
  }

  .dot[data-state="ok"] {
    background: var(--add);
    border-color: var(--add);
  }

  .dot[data-state="busy"] {
    background: var(--ink-3);
    animation: breathe 1.2s ease-in-out infinite;
  }

  .dot[data-state="waiting"] {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .dot[data-state="failed"] {
    background: var(--del);
    border-color: var(--del);
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
    .dot[data-state="busy"] {
      animation: none;
    }
  }

  .media-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    padding: 3px var(--pane-pad) 3px 26px;
    color: var(--ink);
  }

  .media-row:hover,
  .media-row.on {
    background: var(--surface-2);
  }

  /* The tree's cursor, drawn here as it is drawn on the tree's rows, while
     the keyboard is in the pane. */
  .sections.keyed .fold.cursor,
  .sections.keyed .media-row.cursor,
  .sections.keyed .process.cursor,
  .sections.keyed .plugin.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .media-caption {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .media-meta {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
  }

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

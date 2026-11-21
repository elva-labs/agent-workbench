<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import FileTree, { type Beyond, type NameField } from "$lib/components/FileTree.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import RowMenu from "$lib/components/RowMenu.svelte";
  import Plain from "$lib/components/conversation/Plain.svelte";
  import {
    cancelDelete,
    cancelName,
    commitName,
    confirmDelete,
    deleteQuestion,
    fileOps,
    newFile,
    nameLeft,
    newFolder,
    openMenu,
    setName,
  } from "$lib/fileOps.svelte";
  import FoldHead from "$lib/components/FoldHead.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import BrowserView from "$lib/components/BrowserView.svelte";
  import SearchResults from "$lib/components/SearchResults.svelte";
  import EditorColumn from "$lib/components/EditorColumn.svelte";
  import TabRow from "$lib/components/TabRow.svelte";
  import { diskChanged, editor, keep as keepTab, keyOf, openFile, unsavedAt } from "$lib/editor.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import { onMount, tick, untrack } from "svelte";
  import {
    canDiff,
    canPreview,
    effectiveView,
    clear,
    clearQuery,
    closeViewer,
    files,
    openAt,
    refresh,
    search,
    searchingLines,
    select,
    selectedEntry,
    setMode,
    setQuery,
    setScope,
    newBrowserTab,
    openBrowser,
    setView,
    showBrowser,
    shownChanged,
    visible,
  } from "$lib/files.svelte";
  import {
    activate as activateBrowserTab,
    browser,
    close as closeBrowserTab,
    coversBrowser,
    ownTabs as ownBrowserTabs,
    titleFor as browserTitleFor,
  } from "$lib/browser.svelte";
  import { core } from "$lib/core";
  import {
    allowedProjects,
    revoke,
    startedBy,
    stopStarted,
  } from "$lib/conductor.svelte";
  import { isInstalled } from "$lib/hook.svelte";
  import { listed as presentedFor, openItem } from "$lib/media.svelte";
  import {
    boardOf,
    canSend,
    cleanQuestion,
    cleanWorktrees,
    isAsking,
    madeTrees,
    quotedStarted,
    readWorktrees,
    removable,
    sendLine as sendStarted,
    shownStarted,
    startedDetail,
    startedDot,
    startedName,
    stopAllQuestion,
    stopOneQuestion,
    treesFor,
    worktreeLine,
    type LeftTree,
  } from "$lib/orchestrator.svelte";
  import {
    elapsed,
    emptyText as emptyProcesses,
    processes,
    stop as stopProcess,
    type ProcessRow,
  } from "$lib/processes.svelte";
  import {
    askFor,
    factsOf,
    grouped as groupedSections,
    isOpen as rowOpen,
    noticeOf,
    run as runAction,
    toggleOpen as toggleRow,
    type PluginSection,
  } from "$lib/pluginSections.svelte";
  import { open as openPluginView, viewOf as pluginViewOf } from "$lib/pluginView.svelte";
  import type { BrowserTab, PluginAction, PluginRow } from "$lib/core";
  import { lastSegment } from "$lib/paths";
  import {
    activeSession,
    ago,
    close as closeSession,
    isLive,
    type Session,
  } from "$lib/sessions.svelte";
  import { activeProject, followedWorktree, goTo, projectLabel, watchRoot, workspace } from "$lib/workspace.svelte";
  import { putAway } from "$lib/popover";
  import { isOrchestratorFolder } from "$lib/orchestratorFolder.svelte";
  import {
    DEFAULT,
    MIN,
    applyLayout,
    changesHeld,
    editTreeVisible,
    enterReview,
    focusPane,
    giveBackStarted,
    layout,
    lendStarted,
    resetEditTree,
    resizeEditTree,
    saveLayout,
    setStartedOpen as chooseStartedOpen,
    startedShown,
  } from "$lib/layout.svelte";

  let reviewing = $derived(layout.mode === "reviewing");
  let editing = $derived(layout.mode === "editing");
  /** While editing, the tree's column beside the editor, unless the window
      gave it up for the editor's room. */
  let treeColumn = $derived(!editing || editTreeVisible());
  /** A page that asked for the whole pane has it: the tree stands down
      while it shows, and comes back with its folds and its selection. */
  let fullView = $derived(files.pluginView?.width === "full");
  let diffable = $derived(canDiff(selectedEntry()));
  let renderable = $derived(canPreview(selectedEntry()));
  let view = $derived(effectiveView());
  let root = $derived(watchRoot());
  let worktree = $derived(followedWorktree());
  let notGit = $derived(activeProject() !== null && root === null);
  /** The orchestrator folder is in front: it is no open project, so there
      is nothing of it to watch. */
  let folderInFront = $derived(isOrchestratorFolder(workspace.active));

  let field = $state<HTMLInputElement | null>(null);
  let menuOpen = $state(false);
  let presented = $derived(presentedFor());
  /** The tree's column, for turning a drag into a share of it. */
  let columnHeight = $state(0);

  /** The sections' rows as the tree's cursor sees them: each section's
      header, then what it holds while it is open, media first, the
      sessions the session on screen started, processes, the browser, and
      a plugin's fold with its group lines and rows last. */
  let sectionCursor = $state(-1);
  const FOLD_ID = "media-fold";
  const PROCESSES_FOLD_ID = "processes-fold";
  const BROWSER_FOLD_ID = "browser-fold";
  const rowIdOf = (id: string) => `media-${id}`;
  const processRowId = (row: ProcessRow) => `process-${row.pid}`;
  const browserRowId = (tab: BrowserTab) => `browser-tab-${tab.id}`;
  const pluginFoldId = (key: string) => `plugin-fold-${key}`;
  const pluginGroupId = (key: string) => `plugin-group-${key}`;
  const pluginRowId = (key: string, row: PluginRow) => `plugin-row-${key}-${row.id}`;
  type Entry =
    | { id: string; kind: "media-head" }
    | { id: string; kind: "media"; index: number }
    | { id: string; kind: "started-head" }
    | { id: string; kind: "started"; key: string }
    | { id: string; kind: "started-allowed"; project: string }
    | { id: string; kind: "started-trees" }
    | { id: string; kind: "processes-head" }
    | { id: string; kind: "process"; index: number }
    | { id: string; kind: "browser-head" }
    | { id: string; kind: "browser-tab"; index: number }
    | { id: string; kind: "plugin-head"; group: string }
    | { id: string; kind: "plugin-group"; group: string; key: string }
    | {
        id: string;
        kind: "plugin-row";
        group: string;
        key: string;
        /** The group line the row sits under, none in the first section. */
        line: string | null;
        index: number;
      };
  let pluginList = $derived(groupedSections());
  let sectionEntries: Entry[] = $derived.by(() => {
    const list: Entry[] = [];
    if (presented.length > 0) {
      list.push({ id: FOLD_ID, kind: "media-head" });
      if (layout.mediaOpen) {
        presented.forEach((item, index) => list.push({ id: rowIdOf(item.id), kind: "media", index }));
      }
    }
    if (board !== null) {
      list.push({ id: STARTED_FOLD_ID, kind: "started-head" });
      if (startedShown()) {
        for (const session of started) list.push({ id: startedRowId(session.key), kind: "started", key: session.key });
        for (const project of allowedHere) list.push({ id: allowedId(project), kind: "started-allowed", project });
        if (boardTrees.length > 0) list.push({ id: STARTED_TREES_ID, kind: "started-trees" });
      }
    }
    list.push({ id: PROCESSES_FOLD_ID, kind: "processes-head" });
    if (layout.processesOpen) {
      processes.rows.forEach((row, index) => list.push({ id: processRowId(row), kind: "process", index }));
    }
    list.push({ id: BROWSER_FOLD_ID, kind: "browser-head" });
    if (layout.browserOpen) {
      ownBrowserTabs().forEach((tab, index) => list.push({ id: browserRowId(tab), kind: "browser-tab", index }));
    }
    for (const group of pluginList) {
      list.push({ id: pluginFoldId(group.key), kind: "plugin-head", group: group.key });
      if (!sectionOpen(group.key)) continue;
      group.sections.forEach((section, at) => {
        const rows = (line: string | null) =>
          section.rows.forEach((row, index) =>
            list.push({
              id: pluginRowId(section.key, row),
              kind: "plugin-row",
              group: group.key,
              key: section.key,
              line,
              index,
            }),
          );
        if (at === 0) {
          rows(null);
          return;
        }
        list.push({
          id: pluginGroupId(section.key),
          kind: "plugin-group",
          group: group.key,
          key: section.key,
        });
        if (lineOpen(section)) rows(section.key);
      });
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
      else if (entry.kind === "started-head") toggleStarted();
      else if (entry.kind === "started") openStarted(entry.key);
      else if (entry.kind === "started-allowed") revokeProject(entry.project);
      else if (entry.kind === "started-trees") askClean();
      else if (entry.kind === "processes-head") toggleProcesses();
      else if (entry.kind === "browser-head") toggleBrowser();
      else if (entry.kind === "browser-tab") {
        const tab = ownBrowserTabs()[entry.index];
        if (tab !== undefined) void selectBrowserTab(tab.id);
      } else if (entry.kind === "plugin-head") toggleSection(entry.group);
      else if (entry.kind === "plugin-group") {
        const section = sectionAt(entry.key);
        if (section !== undefined) setSectionOpen(entry.key, !lineOpen(section));
      } else if (entry.kind === "plugin-row") {
        const section = sectionAt(entry.key);
        if (section !== undefined) pressRow(section, section.rows[entry.index]);
      }
    },
    key: (index, e) => {
      const entry = sectionEntries[index];
      if (entry === undefined || e.metaKey || e.ctrlKey || e.altKey) return false;
      const deleting = (e.key === "Delete" || e.key === "Backspace") && !e.shiftKey;
      if (entry.kind === "started-head") {
        if (!deleting) return false;
        askStopAll();
        return true;
      }
      if (entry.kind !== "started") return false;
      const session = started.find((row) => row.key === entry.key);
      if (session === undefined) return false;
      if (e.key === "Enter" && e.shiftKey) {
        if (sending !== session.key) openSend(session);
        return true;
      }
      if (!deleting) return false;
      askStop(session);
      return true;
    },
    fold: (index, open) => {
      const entry = sectionEntries[index];
      if (entry === undefined) return;
      if (entry.kind === "plugin-head") {
        if (open === sectionOpen(entry.group)) return;
        setSectionOpen(entry.group, open);
        if (!open) sectionCursor = index;
        return;
      }
      if (entry.kind === "plugin-row") {
        // A row with facts opens and shuts on its own before Left goes on
        // to fold the line it sits under.
        const section = sectionAt(entry.key);
        const row = section?.rows[entry.index];
        if (section !== undefined && row !== undefined && factsOf(row).length > 0) {
          if (open) {
            toggleRow(section, row, true);
            return;
          }
          if (rowOpen(section, row)) {
            toggleRow(section, row, false);
            return;
          }
        }
      }
      if (entry.kind === "plugin-group" || entry.kind === "plugin-row") {
        // A group line opens and folds on its own; a row folds the line it
        // sits under. Folding again, or from anything the first section
        // holds, takes the plugin's whole fold with it.
        const line = entry.kind === "plugin-group" ? entry.key : entry.line;
        const section = line === null ? undefined : sectionAt(line);
        const lineIsOpen = section !== undefined && lineOpen(section);
        if (open) {
          if (entry.kind === "plugin-group" && !lineIsOpen) setSectionOpen(entry.key, true);
          return;
        }
        if (line !== null && (entry.kind === "plugin-row" || lineIsOpen)) {
          const at = sectionEntries.findIndex(
            (candidate) => candidate.kind === "plugin-group" && candidate.key === line,
          );
          setSectionOpen(line, false);
          sectionCursor = at;
          return;
        }
        const head = sectionEntries.findIndex(
          (candidate) => candidate.kind === "plugin-head" && candidate.group === entry.group,
        );
        setSectionOpen(entry.group, false);
        sectionCursor = head;
        return;
      }
      if (
        entry.kind === "started-head" ||
        entry.kind === "started" ||
        entry.kind === "started-allowed" ||
        entry.kind === "started-trees"
      ) {
        if (open === startedShown()) return;
        setStartedOpen(open);
        if (!open) sectionCursor = sectionEntries.findIndex((candidate) => candidate.kind === "started-head");
        return;
      }
      // Media, processes and the browser each fold the same way: a row
      // folds the section it sits under, and leaves the cursor on its header.
      const headKind =
        entry.kind === "media-head" || entry.kind === "media"
          ? "media-head"
          : entry.kind === "processes-head" || entry.kind === "process"
            ? "processes-head"
            : "browser-head";
      const head = sectionEntries.findIndex((candidate) => candidate.kind === headKind);
      if (headKind === "media-head") {
        if (open === layout.mediaOpen) return;
        layout.mediaOpen = open;
      } else if (headKind === "processes-head") {
        if (open === layout.processesOpen) return;
        layout.processesOpen = open;
      } else {
        if (open === layout.browserOpen) return;
        layout.browserOpen = open;
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

  let anyOpen = $derived.by(
    () =>
      (presented.length > 0 && layout.mediaOpen) ||
      (board !== null && startedShown()) ||
      layout.processesOpen ||
      layout.browserOpen ||
      pluginList.some((group) => sectionOpen(group.key)),
  );

  /** A plugin's fold is folded until it is asked for, and the answer is
      remembered by its key. */
  function sectionOpen(key: string) {
    return layout.sectionsOpen[key] === true;
  }

  /** A group line inside a plugin's fold stands as the section asked to be
      drawn until someone says otherwise. */
  function lineOpen(section: PluginSection) {
    return layout.sectionsOpen[section.key] ?? !section.folded;
  }

  /** The section a key names among the groups on screen. */
  function sectionAt(key: string) {
    for (const group of pluginList) {
      const found = group.sections.find((section) => section.key === key);
      if (found !== undefined) return found;
    }
    return undefined;
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

  /** A row with facts opens and shuts when pressed, its actions staying on
      its buttons; any other row runs its default action. */
  function pressRow(section: PluginSection, row: PluginRow | undefined) {
    if (row === undefined) return;
    if (factsOf(row).length > 0) toggleRow(section, row);
    else runDefault(section, row);
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

  function toggleBrowser() {
    layout.browserOpen = !layout.browserOpen;
    saveLayout();
  }

  /** A row's own state dot: busy while the tab is loading, failed once it
      holds an error, ok otherwise. */
  function browserDot(tab: BrowserTab): string {
    if (tab.error !== null) return "failed";
    if (tab.loading) return "busy";
    return "ok";
  }

  /** A row's detail line: the tab's url without its scheme. */
  function withoutScheme(url: string): string {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  }

  /** A row or Enter on it: bring that tab to the front and show it, the way
      a click on its row in the tab strip does. */
  async function selectBrowserTab(id: number) {
    await activateBrowserTab(id);
    showBrowser();
  }

  // A chord asked for the field: put the keyboard in it, whatever had it.
  $effect(() => {
    files.fieldRequests;
    if (files.fieldRequests > 0 && field) {
      field.focus();
      field.select();
    }
  });

  /** A mode picked with the pointer is for typing in: the keyboard goes to
      the field, and stays there when it was there. Picked from the
      keyboard, it stays on the modes, as in any radio group. */
  function pickMode(e: MouseEvent, mode: "files" | "lines") {
    setMode(mode);
    if (e.detail > 0) field?.focus();
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // Once to clear, once more to leave, as the field's own convention.
      e.stopPropagation();
      if (files.query !== "") clearQuery();
      else field?.blur();
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
      const next = field?.closest("section")?.querySelector<HTMLElement>(
        "[data-testid='file-tree'], [data-testid='search-results'] button.hit",
      );
      next?.focus();
    }
  }

  function openHit(path: string, line: number) {
    if (editing) {
      void openFile(path, { line });
      return;
    }
    void openAt(path, line);
    enterReview();
  }

  /** The "⋯" menu and its button. Open, the menu has the keyboard on the
      choice in force, or its first item; the arrows walk it, Enter picks,
      Escape closes it back to the button and Tab closes it on the way on. */
  let more = $state<HTMLDivElement | null>(null);

  function menuItems(): HTMLButtonElement[] {
    return [...(more?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? [])];
  }

  // Escape wherever the keyboard is, a press outside the button and its menu,
  // the window losing focus or changing size puts the menu away.
  $effect(() => {
    if (!menuOpen) return;
    return putAway({ inside: () => [more], close: () => (menuOpen = false), control: () => more?.querySelector("button") });
  });

  function toggleMenu() {
    menuOpen = !menuOpen;
    if (!menuOpen) return;
    void tick().then(() =>
      (more?.querySelector<HTMLButtonElement>("[role='menuitemradio'][aria-checked='true']:not(:disabled)") ?? menuItems()[0])?.focus(),
    );
  }

  /** The button again, once the menu that had the keyboard is gone, unless
      what was picked took the keyboard somewhere else. */
  function backToButton() {
    void tick().then(() => {
      const holder = document.activeElement;
      if (holder === null || holder === document.body) more?.querySelector<HTMLButtonElement>("[data-testid='changes-menu']")?.focus();
    });
  }

  function choose(run: () => void) {
    const keyboard = more?.querySelector(".menu")?.contains(document.activeElement) ?? false;
    run();
    menuOpen = false;
    if (keyboard) backToButton();
  }

  function onMenuKeydown(e: KeyboardEvent) {
    if (!menuOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      menuOpen = false;
      backToButton();
      return;
    }
    if (e.key === "Tab") {
      menuOpen = false;
      return;
    }
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = items[(at + 1) % items.length];
    else if (e.key === "ArrowUp") next = items[(at - 1 + items.length) % items.length];
    else if (e.key === "Home") next = items[0];
    else if (e.key === "End") next = items[items.length - 1];
    else return;
    e.preventDefault();
    next?.focus();
  }

  onMount(() => {
    const offs: (() => void)[] = [];
    // The agent edits a file and the pane reacts without being asked. The core
    // does not say what changed, only that something did: re-reading status is
    // cheap, and being right beats diffing two states.
    core()
      .onGitChanged(() => refresh())
      .then((unlisten) => offs.push(unlisten));
    // A file the viewer shows from outside the tree, or one the tree
    // watcher ignores, changed: the viewer reads it again.
    core()
      .onShownChanged((paths) => {
        shownChanged();
        // The editor's open files are among the shown ones.
        diskChanged(paths);
      })
      .then((unlisten) => offs.push(unlisten));
    return () => offs.forEach((off) => off());
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

  /** A file in the tree: in the viewer, or while editing as the preview
      tab, with the keyboard left in the tree for the next file. */
  function open(path: string) {
    if (editing) {
      void openFile(path);
      return;
    }
    select(path);
    enterReview();
  }

  /** The name field in the tree while editing, as the tree draws it. */
  let nameField: NameField | null = $derived.by(() => {
    const naming = fileOps.naming;
    if (!editing || naming === null) return null;
    return {
      folder: naming.kind === "rename" ? null : naming.folder,
      rename: naming.kind === "rename" ? naming.path : null,
      pending: naming.kind === "first" ? fileOps.pending : null,
      folderIcon: naming.kind === "folder" || (naming.kind === "rename" && naming.dir),
      value: fileOps.name,
      problem: fileOps.problem,
      label:
        naming.kind === "folder"
          ? "Name of the new folder"
          : naming.kind === "rename"
            ? "New name"
            : naming.kind === "first"
              ? `Name of the first file in ${naming.folder}`
              : "Name of the new file",
      placeholder:
        naming.kind === "folder"
          ? "Name of the new folder"
          : naming.kind === "first"
            ? "Name of the first file"
            : naming.kind === "rename"
              ? ""
              : "Name of the new file",
      onInput: setName,
      onCommit: () => void commitName(),
      onCancel: cancelName,
      onLeave: nameLeft,
      session: fileOps.session,
    };
  });
  let deleting = $derived(deleteQuestion());

  /** A double-click on a file while editing keeps its tab. */
  function keepOpen(path: string) {
    if (!editing || root === null) return;
    void openFile(path, { keep: true });
    keepTab(keyOf(root, path));
  }

  function resizeTree(dx: number) {
    layout.tree = Math.max(MIN.tree, layout.treeDrawn + dx);
    applyLayout(layout.width);
  }

  function resetTree() {
    layout.tree = DEFAULT.tree;
    applyLayout(layout.width);
    saveLayout();
  }

  /** The session on screen, while it has started sessions of its own, has
      them in a section at the foot of the tree's column, beside Processes
      and Browser, walked by the tree's cursor as they are. */
  let board = $derived(boardOf(activeSession()));
  let started = $derived(board === null ? [] : startedBy(board.token));
  let asking = $derived(started.filter(isAsking).length);
  let paneMeta = $derived(worktree === null ? undefined : `worktree ${worktree}`);
  /** While editing the pane is named for the project, heading the tree's
      column, and the editor's tabs head the column beside it. */
  let paneTitle = $derived.by(() => {
    if (editing) return workspace.active === null ? "Files" : projectLabel(workspace.active);
    return "Changes";
  });
  let titleWidth = $derived.by(() => {
    if (!editing) return null;
    // The cell is as wide as the column under it, so the tabs beside it
    // stand over the editor.
    return editTreeVisible() ? `calc(${layout.editTreeDrawn}px + var(--splitter-inner-w))` : "auto";
  });

  /** The projects this session may start sessions in without being
      asked, each with the × that takes the standing answer back. */
  let allowedHere = $derived(board === null ? [] : allowedProjects(board.token));
  /** The worktrees the line under the sessions counts: those its own
      starts made and left behind. */
  let boardTrees = $derived(board === null ? [] : treesFor(board));
  /** The row with the send field under it: one at a time, and only while
      that session is running. */
  let sending = $state<string | null>(null);
  let sendLine = $state("");
  let sendField = $state<HTMLInputElement | null>(null);
  let liveStarted = $derived(started.filter(isLive).length);
  let cleaning = $state(false);
  /** Whether the line says what is left behind or why what is left stayed. */
  let cleaned = $state(false);

  /** The next start this caller makes in that project is put to the user. */
  function revokeProject(project: string) {
    if (board === null) return;
    revoke(board.token, project);
  }

  function stopRow(session: Session) {
    if (sending === session.key) sending = null;
    stopStarted(session.key);
  }

  function openSend(session: Session) {
    if (!canSend(session)) return;
    sending = sending === session.key ? null : session.key;
    sendLine = "";
  }

  function closeSend() {
    sending = null;
    sendLine = "";
  }

  /** What the field holds, sent to the session the field is under: one
      line, typed into a terminal as the conductor's own send tool types
      one, or an integrated session's message from the user. */
  function sendTo(session: Session) {
    sendStarted(session, sendLine);
    closeSend();
  }

  function onSendKeydown(e: KeyboardEvent, session: Session) {
    // The board reads the arrows and Enter for its cursor; while the field
    // is open those keys are the field's.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      sendTo(session);
      keysBack();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSend();
      keysBack();
    }
  }

  // The field is opened to be typed into, so it takes the keyboard.
  $effect(() => {
    if (sending !== null) sendField?.focus();
  });

  /** The session whose worktrees left behind are read: the one whose
      section shows, or the one on screen whose starts made a worktree, so
      the section can show for what they left. */
  let readFor = $derived.by(() => {
    if (board !== null) return board.key;
    const session = activeSession();
    return madeTrees(session) ? session!.key : null;
  });

  // What the starts left behind, read while the board or the section is on
  // screen and again whenever one of the sessions comes or goes.
  $effect(() => {
    if (readFor === null) return;
    liveStarted;
    untrack(() => {
      cleaned = false;
      void readWorktrees();
    });
  });

  async function cleanUp(trees: LeftTree[]) {
    cleaning = true;
    try {
      await cleanWorktrees(trees);
    } finally {
      cleaning = false;
      cleaned = true;
    }
  }

  /** The section at the tree's foot: its header, each session it started,
      each project it may start in and the worktrees left behind, as the
      tree's cursor walks them. */
  const STARTED_FOLD_ID = "started-fold";
  const STARTED_TREES_ID = "started-trees";
  const startedRowId = (key: string) => `started-row-${key}`;
  const allowedId = (project: string) => `started-allowed-${encodeURIComponent(project)}`;

  function toggleStarted() {
    setStartedOpen(!startedShown());
  }

  /** Folded, the section puts away what was open in it. */
  function setStartedOpen(open: boolean) {
    chooseStartedOpen(open);
    if (open) return;
    asked = null;
    closeSend();
  }

  /** A row opened by its click or Enter: the session it shows, with the
      keyboard, and its project brought forward. */
  function openStarted(key: string) {
    if (goTo(key)) focusPane("agent");
  }

  /** The question up in the section, for the session it was asked about:
      every session it started then, or the worktrees that could go then.
      Only those are acted on, whatever has come since. */
  let asked = $state<
    | { kind: "stop-all"; starter: string; keys: string[] }
    | { kind: "stop-one"; starter: string; keys: string[] }
    | { kind: "clean"; starter: string; paths: string[] }
    | null
  >(null);
  /** The rows a question to stop them was asked about, still there. */
  let askedRows = $derived.by(() => {
    const was = asked;
    return was?.kind === "stop-all" || was?.kind === "stop-one"
      ? started.filter((row) => was.keys.includes(row.key))
      : [];
  });
  /** The worktrees the question to clean up was asked about, still there. */
  let askedTrees = $derived.by(() => {
    const was = asked;
    return was?.kind === "clean" ? boardTrees.filter((left) => was.paths.includes(left.path)) : [];
  });

  function askStopAll() {
    if (board === null || !started.some(isLive)) return;
    closeSend();
    asked = { kind: "stop-all", starter: board.key, keys: started.map((row) => row.key) };
  }

  /** Stopping one from the keyboard asks first, under its row. */
  function askStop(session: Session) {
    if (board === null) return;
    closeSend();
    asked = { kind: "stop-one", starter: board.key, keys: [session.key] };
  }

  function askClean() {
    if (board === null) return;
    const going = removable(boardTrees);
    if (going.length === 0) return;
    asked = { kind: "clean", starter: board.key, paths: going.map((left) => left.path) };
  }

  function confirmAsked() {
    const was = asked;
    const rows = askedRows;
    const trees = askedTrees;
    asked = null;
    if (was === null || board === null || was.starter !== board.key) return;
    if (was.kind === "clean") void cleanUp(trees);
    else for (const row of rows) stopRow(row);
    keysBack();
  }

  function cancelAsked() {
    asked = null;
    keysBack();
  }

  // A question or a send field is about the session it was opened for:
  // another session on screen puts it away, and so does nothing being left
  // to ask about.
  let starterKey = $derived(board?.key ?? null);
  $effect(() => {
    starterKey;
    untrack(() => {
      asked = null;
      closeSend();
    });
  });
  $effect(() => {
    if (
      (asked?.kind === "stop-all" && !askedRows.some(isLive)) ||
      (asked?.kind === "stop-one" && askedRows.length === 0) ||
      (asked?.kind === "clean" && askedTrees.length === 0)
    )
      untrack(() => (asked = null));
  });

  // A question opened in the section is brought whole into its share of
  // the column, which may be scrolled to show only a row or two.
  $effect(() => {
    if (asked === null) return;
    void tick().then(() =>
      document
        .querySelector("section[data-pane='changes'] [data-testid='board-section'] .board-ask")
        ?.scrollIntoView({ block: "nearest" }),
    );
  });

  /** Which section an entry is in. */
  function sectionOfEntry(entry: Entry): string {
    switch (entry.kind) {
      case "media-head":
      case "media":
        return "media";
      case "started-head":
      case "started":
      case "started-allowed":
      case "started-trees":
        return "started";
      case "processes-head":
      case "process":
        return "processes";
      case "browser-head":
      case "browser-tab":
        return "browser";
      default:
        return `plugin:${entry.group}`;
    }
  }

  /** Where the cursor goes when the rows change under it without it being
      moved: to the row it was on, wherever that row is now. A row that has
      gone leaves it on the row that took its place in the same section, or
      that section's header; the sessions of another starter, on its
      header; and a section that has gone, on the header of the section
      after it, or before it. */
  function followed(before: Entry[], at: number, now: Entry[], sameStarter: boolean): number {
    const found = now.findIndex((entry) => entry.id === before[at].id);
    if (found !== -1) return found;
    const section = sectionOfEntry(before[at]);
    const start = before.findIndex((entry) => sectionOfEntry(entry) === section);
    const inNow = now.flatMap((entry, index) => (sectionOfEntry(entry) === section ? [index] : []));
    if (inNow.length > 0) {
      if (section === "started" && !sameStarter) return inNow[0];
      return inNow[Math.min(at - start, inNow.length - 1)];
    }
    const order = [...new Set(before.map(sectionOfEntry))];
    const place = order.indexOf(section);
    for (const other of [...order.slice(place + 1), ...order.slice(0, place).reverse()]) {
      const head = now.findIndex((entry) => sectionOfEntry(entry) === other);
      if (head !== -1) return head;
    }
    return -1;
  }

  // The cursor follows the row it is on, never a position: sessions start
  // and stop, and media and processes come and go, while it rests.
  let heldCursor: { entries: Entry[]; at: number; starter: string | null } | null = null;
  $effect(() => {
    const now = sectionEntries;
    const at = sectionCursor;
    const key = starterKey;
    untrack(() => {
      const was = heldCursor;
      heldCursor = { entries: now, at, starter: key };
      if (was === null || was.entries === now || was.at !== at || at < 0 || was.entries[at] === undefined) return;
      const next = followed(was.entries, at, now, was.starter === key);
      if (next === at) return;
      sectionCursor = next;
      heldCursor = { entries: now, at: next, starter: key };
    });
  });

  /** The keyboard back on the tree once a field or a question in the
      section has gone, since the cursor that walks the section is the
      tree's. */
  function keysBack() {
    if (board === null) return;
    void tick().then(() =>
      document.querySelector<HTMLElement>("section[data-pane='changes'] [data-testid='file-tree']")?.focus(),
    );
  }

  /** How long ago each row last changed, kept current while the section
      shows. */
  let now = $state(Date.now());
  $effect(() => {
    if (board === null) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  // One of them starting to ask while its starter is on screen lends a
  // folded section open, so the row that asks is in sight; the fold the
  // user chose stands. The section folds again once none of them asks or
  // another session shows. Coming on screen while one already asks, as a
  // switch or a restart does, lends nothing.
  let askingHere = $derived(board === null ? 0 : asking);
  let askedBefore: { key: string | null; count: number } | null = null;
  $effect(() => {
    const key = board?.key ?? null;
    const count = askingHere;
    untrack(() => {
      const before = askedBefore;
      askedBefore = { key, count };
      if (before === null || key !== before.key || count === 0) {
        giveBackStarted();
        return;
      }
      if (count > before.count) lendStarted();
    });
  });
</script>

{#snippet tabs()}
  <TabRow />
{/snippet}

<!-- A new file or folder where the tree's cursor is, heading the tree's
     column. -->
{#snippet makers()}
  <button
    class="maker"
    onpointerdown={(e) => e.preventDefault()}
    onclick={() => newFile()}
    aria-label="New file"
    title="New file  {describe(chordFor('file.new'))}"
    data-testid="tree-new-file"
  >
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14H4V2h5l3 3v3M9 2v3h3M12 10.5v4M10 12.5h4" /></svg>
  </button>
  <button
    class="maker"
    onpointerdown={(e) => e.preventDefault()}
    onclick={() => newFolder()}
    aria-label="New folder"
    title="New folder"
    data-testid="tree-new-folder"
  >
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.5 12.5H2v-8h4L7.5 6H14v2.5M12 10.5v4M10 12.5h4" /></svg>
  </button>
{/snippet}

<Pane
  id="changes"
  title={paneTitle}
  meta={paneMeta}
  {titleWidth}
  head={titleWidth === null ? undefined : tabs}
  cellEnd={titleWidth !== null && editTreeVisible() ? makers : undefined}
>
  {#if !editing}
    {@render fieldRow()}
  {/if}

  <!-- The tree is the same component in both shapes. Working, it has the pane
       to itself; reviewing, it becomes the left column and keeps its scroll
       position, its open folders and its selection. -->
  <div
    class="split"
    class:reviewing
    class:editing
    class:treeless={editing && !editTreeVisible()}
    class:full={fullView}
    style:--tree-w="{editing ? layout.editTreeDrawn : layout.treeDrawn}px"
    style:width={changesHeld() === 0 ? null : `calc(100% + ${changesHeld()}px)`}
  >
    <!-- The tree's column: the tree, and beneath it what the agent
         presented for the session on screen, a section of its own with a
         divider to drag, folded to its header when asked. -->
    {#if !fullView && treeColumn}
      <!-- While editing, the keyboard anywhere in this column, the field
           or the tree, is the tree's side of the pane. -->
      <div
        class="column"
        bind:clientHeight={columnHeight}
        onfocusin={() => (editor.target = "tree")}
        data-testid="tree-column"
      >
        {#if editing}
          {@render fieldRow()}
          {#if fileOps.failed !== null}
            <p class="notice error" role="alert" data-testid="tree-failed">{fileOps.failed}</p>
          {/if}
          {#if deleting !== null}
            <div class="delete">
              <ConfirmStrip
                question={deleting.question}
                detail={deleting.detail}
                action="Delete"
                onConfirm={() => void confirmDelete()}
                onCancel={cancelDelete}
                testid="delete-confirm"
              />
            </div>
          {/if}
        {/if}
        <div class="tree-slot">
          {#if searchingLines()}
            <SearchResults onOpen={openHit} />
          {:else}
            <FileTree
              onOpen={open}
              onDouble={editing ? keepOpen : undefined}
              onBlank={editing ? undefined : closeViewer}
              focused={layout.focus === "changes" && (!editing || editor.target === "tree")}
              unsaved={unsavedAt}
              field={nameField}
              onMenu={editing ? openMenu : undefined}
              onCursorRow={(row) => (fileOps.cursor = row)}
              marked={fileOps.menu?.path ?? fileOps.deleting?.path ?? null}
              {beyond}
            />
          {/if}
        </div>
        {#if anyOpen}
          <Splitter
            label="Resize the sections under the tree"
            orientation="horizontal"
            inner
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
          <!-- The sessions the session on screen started, with what it was
               allowed and what their worktrees left: a section like its
               neighbours, folded and walked the same way, there while it
               has any of them. A name is the agent's text, drawn as it is
               and cut to what a row holds. Each row's buttons act on the
               session that row shows, and stopping them all or cleaning
               up asks first. -->
          {#if board !== null}
            <section class="section board-section" class:open={startedShown()} data-testid="board-section">
              <div class="section-head">
                <button
                  id={STARTED_FOLD_ID}
                  class="fold strong"
                  class:cursor={cursorId === STARTED_FOLD_ID}
                  tabindex="-1"
                  onpointerdown={(e) => e.preventDefault()}
                  onclick={() => {
                    sectionCursor = sectionEntries.findIndex((entry) => entry.kind === "started-head");
                    toggleStarted();
                  }}
                  aria-expanded={startedShown()}
                  data-testid="board-fold"
                >
                  <span class="chevron">{startedShown() ? "▾" : "▸"}</span>
                  Sessions it started ({started.length})
                </button>
                {#if started.some(isLive)}
                  <span class="head-actions">
                    <button
                      class="head-action accent"
                      tabindex="-1"
                      onpointerdown={(e) => e.preventDefault()}
                      onclick={askStopAll}
                      title="Stop every session it started (Delete)"
                      data-testid="board-stop-all">Stop all</button
                    >
                  </span>
                {/if}
              </div>
              {#if startedShown()}
                {#if asked?.kind === "stop-all"}
                  {@const ask = stopAllQuestion(askedRows)}
                  <div class="board-ask">
                    <ConfirmStrip
                      question={ask.question}
                      detail={ask.detail}
                      action={ask.action}
                      onConfirm={confirmAsked}
                      onCancel={cancelAsked}
                      testid="board-stop-all-ask"
                    />
                  </div>
                {/if}
                <!-- The tree's cursor walks the list, so it is no stop of its
                     own, even where it scrolls. -->
                <ul class="rows" tabindex="-1">
                  {#if started.length === 0}
                    <li class="section-empty" data-testid="board-empty">None open now.</li>
                  {/if}
                  {#each started as session (session.key)}
                    <li
                      id={startedRowId(session.key)}
                      class="started"
                      class:cursor={cursorId === startedRowId(session.key)}
                      data-row={session.key}
                      data-testid="board-row"
                    >
                      <div class="row-box">
                        <button
                          class="media-row"
                          tabindex="-1"
                          onpointerdown={(e) => e.preventDefault()}
                          onclick={() => {
                            sectionCursor = sectionEntries.findIndex((entry) => entry.id === startedRowId(session.key));
                            openStarted(session.key);
                          }}
                          title={shownStarted(session)}
                          data-testid="board-open"
                        >
                          <span class="row-line">
                            <span class="dot" data-state={startedDot(session)} data-testid="board-dot"></span>
                            <span class="media-caption" data-testid="board-name"><Plain text={startedName(session)} /></span>
                          </span>
                          <span class="media-meta" data-testid="board-detail">{startedDetail(board, session, now)}</span>
                        </button>
                        <span class="actions">
                          <button
                            class="icon word"
                            tabindex="-1"
                            onpointerdown={(e) => e.preventDefault()}
                            onclick={() => {
                              sectionCursor = sectionEntries.findIndex((entry) => entry.id === startedRowId(session.key));
                              openSend(session);
                            }}
                            disabled={!canSend(session)}
                            aria-label="Send a line to {quotedStarted(session)}"
                            title="Send this session a line (Shift+Enter)"
                            data-testid="board-send">Send</button
                          >
                          <button
                            class="icon"
                            tabindex="-1"
                            onpointerdown={(e) => e.preventDefault()}
                            onclick={() => stopRow(session)}
                            aria-label="Stop {quotedStarted(session)}"
                            title="Stop (Delete asks first)"
                            data-testid="board-stop">×</button
                          >
                        </span>
                      </div>
                      {#if sending === session.key}
                        <input
                          class="send"
                          bind:this={sendField}
                          bind:value={sendLine}
                          onkeydown={(e) => onSendKeydown(e, session)}
                          placeholder="a line to send…"
                          aria-label="Send a line to {quotedStarted(session)}"
                          spellcheck="false"
                          autocomplete="off"
                          data-testid="board-send-field"
                        />
                      {/if}
                      {#if asked?.kind === "stop-one" && asked.keys[0] === session.key}
                        {@const ask = stopOneQuestion(session)}
                        <div class="board-ask row-ask">
                          <ConfirmStrip
                            question={ask.question}
                            detail={ask.detail}
                            action={ask.action}
                            onConfirm={confirmAsked}
                            onCancel={cancelAsked}
                            testid="board-stop-ask"
                          />
                        </div>
                      {/if}
                    </li>
                  {/each}
                  {#each allowedHere as project (project)}
                    <li class="board-line" data-testid="board-allowed">
                      <span>Allowed to start sessions in</span>
                      <span id={allowedId(project)} class="allowed" class:cursor={cursorId === allowedId(project)}
                        ><span data-testid="board-allowed-project">{projectLabel(project)}</span><button
                          class="revoke"
                          tabindex="-1"
                          onpointerdown={(e) => e.preventDefault()}
                          onclick={() => {
                            sectionCursor = sectionEntries.findIndex((entry) => entry.id === allowedId(project));
                            revokeProject(project);
                          }}
                          aria-label="Ask again before starting a session in {projectLabel(project)}"
                          title="Ask again"
                          data-testid="board-revoke">×</button
                        ></span
                      >
                    </li>
                  {/each}
                  {#if boardTrees.length > 0}
                    {#if asked?.kind === "clean"}
                      {@const ask = cleanQuestion(
                        boardTrees.filter((left) => asked?.kind === "clean" && (asked.paths.includes(left.path) || removable([left]).length === 0)),
                      )}
                      <li class="board-ask">
                        <ConfirmStrip
                          question={ask.question}
                          detail={ask.detail}
                          action={ask.action}
                          onConfirm={confirmAsked}
                          onCancel={cancelAsked}
                          testid="board-clean-ask"
                        />
                      </li>
                    {:else}
                      <li
                        id={STARTED_TREES_ID}
                        class="board-line"
                        class:cursor={cursorId === STARTED_TREES_ID}
                        data-testid="board-trees"
                      >
                        <span>{worktreeLine(boardTrees, cleaned)}</span>
                        <button
                          class="head-action accent"
                          tabindex="-1"
                          onpointerdown={(e) => e.preventDefault()}
                          onclick={() => {
                            sectionCursor = sectionEntries.findIndex((entry) => entry.id === STARTED_TREES_ID);
                            askClean();
                          }}
                          disabled={cleaning || removable(boardTrees).length === 0}
                          data-testid="board-clean">Clean up</button
                        >
                      </li>
                    {/if}
                  {/if}
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
                <p class="section-empty" data-testid="processes-empty">{emptyProcesses()}</p>
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
          <!-- The browser: how it is opened, and its open tabs. Stands
               even with none open, since opening one is what the fold is
               for; its header carries that action beside the fold. -->
          <section class="section" class:open={layout.browserOpen} data-testid="browser-section">
            <div class="section-head">
              <button
                id={BROWSER_FOLD_ID}
                class="fold"
                class:cursor={cursorId === BROWSER_FOLD_ID}
                tabindex="-1"
                onpointerdown={(e) => e.preventDefault()}
                onclick={() => {
                  sectionCursor = sectionEntries.findIndex((entry) => entry.kind === "browser-head");
                  toggleBrowser();
                }}
                aria-expanded={layout.browserOpen}
                data-testid="browser-fold"
              >
                <span class="chevron">{layout.browserOpen ? "▾" : "▸"}</span>
                Browser ({ownBrowserTabs().length})
              </button>
              <span class="head-actions">
                <button
                  class="head-action"
                  tabindex="-1"
                  onpointerdown={(e) => e.preventDefault()}
                  onclick={() => void newBrowserTab()}
                  data-testid="browser-fold-new-tab">New tab</button
                >
              </span>
            </div>
            {#if layout.browserOpen}
              {#if ownBrowserTabs().length === 0}
                <p class="section-empty" data-testid="browser-fold-empty">No tabs open.</p>
              {:else}
                <ul class="rows">
                  {#each ownBrowserTabs() as tab (tab.id)}
                    <li
                      class="browser-tab"
                      class:cursor={cursorId === browserRowId(tab)}
                      id={browserRowId(tab)}
                      data-testid="browser-fold-row"
                    >
                      <button
                        class="media-row"
                        class:on={browser.showing && tab.front}
                        tabindex="-1"
                        onpointerdown={(e) => e.preventDefault()}
                        onclick={() => {
                          sectionCursor = sectionEntries.findIndex((entry) => entry.id === browserRowId(tab));
                          void selectBrowserTab(tab.id);
                        }}
                        title={tab.url}
                      >
                        <span class="row-line">
                          <span class="dot" data-state={browserDot(tab)} data-testid="browser-fold-dot"></span>
                          <span class="media-caption">{browserTitleFor(tab)}</span>
                        </span>
                        <span class="media-meta">
                          {#if tab.opener.kind === "agent"}<span class="by" data-testid="browser-fold-agent">agent</span>{" "}{/if}{withoutScheme(tab.url)}
                        </span>
                      </button>
                      <button
                        class="stop"
                        tabindex="-1"
                        onpointerdown={(e) => e.preventDefault()}
                        onclick={() => void closeBrowserTab(tab.id)}
                        aria-label="Close {browserTitleFor(tab)}"
                        title="Close"
                        data-testid="browser-fold-close">×</button
                      >
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </section>
          <!-- A plugin's sections: one fold, named and counted for the
               plugin, with the first section on the fold itself and every
               further one a group inside it. -->
          {#each pluginList as group (group.key)}
            {@const open = sectionOpen(group.key)}
            {@const notice = noticeOf(group)}
            {@const page = pluginViewOf(group.key)}
            {@const head = group.sections[0]}
            <section class="section" class:open data-plugin={group.key} data-testid="plugin-section">
              {#snippet viewButton()}
                {#if page !== null}
                  <button
                    class="head-action"
                    tabindex="-1"
                    onpointerdown={(e) => e.preventDefault()}
                    onclick={() => openPluginView(page.key, page.project)}
                    data-testid="plugin-view-open">View</button
                  >
                {/if}
              {/snippet}
              <FoldHead
                {open}
                title={group.title}
                detail={group.detail}
                count={group.count}
                actions={head.actions}
                onToggle={() => {
                  sectionCursor = sectionEntries.findIndex(
                    (entry) => entry.kind === "plugin-head" && entry.group === group.key,
                  );
                  toggleSection(group.key);
                }}
                onAct={(action) => act(head, action, null)}
                foldId={pluginFoldId(group.key)}
                cursor={cursorId === pluginFoldId(group.key)}
                testId="plugin-fold"
                lead={page === null ? undefined : viewButton}
              />
              {#if notice !== null}
                <p class="section-notice" data-testid="plugin-notice">{notice}</p>
              {/if}
              {#if open}
                <ul class="rows">
                  {@render pluginRows(head, false)}
                  {#each group.sections.slice(1) as section (section.key)}
                    {@const lineIsOpen = lineOpen(section)}
                    <li
                      id={pluginGroupId(section.key)}
                      class="group-line"
                      class:cursor={cursorId === pluginGroupId(section.key)}
                      data-section={section.section}
                      data-testid="plugin-group"
                    >
                      <FoldHead
                        open={lineIsOpen}
                        title={section.title}
                        detail={section.detail}
                        count={section.rows.length}
                        actions={section.actions}
                        onToggle={() => {
                          sectionCursor = sectionEntries.findIndex(
                            (entry) => entry.id === pluginGroupId(section.key),
                          );
                          setSectionOpen(section.key, !lineIsOpen);
                        }}
                        onAct={(action) => act(section, action, null)}
                        testId="plugin-group-fold"
                        group
                      />
                    </li>
                    {#if lineIsOpen}
                      {@render pluginRows(section, true)}
                    {/if}
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        </div>
      </div>
    {/if}
    {#if reviewing}
      {#if !fullView}
        <Splitter label="Resize the file tree" inner onDelta={resizeTree} onReset={resetTree} onCommit={saveLayout} />
      {/if}
      {#if browser.showing}
        <BrowserView />
      {:else}
        <FileViewer />
      {/if}
    {/if}
    {#if editing}
      {#if !fullView && treeColumn}
        <Splitter
          label="Resize the file tree"
          inner
          onDelta={resizeEditTree}
          onReset={resetEditTree}
          onCommit={saveLayout}
        />
      {/if}
      <EditorColumn />
    {/if}
  </div>
</Pane>



<!-- The field above the tree, with the notices under it: across the pane
     while working and reviewing, at the top of the tree's column while
     editing. -->
{#snippet fieldRow()}
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
        placeholder={editing
          ? files.mode === "lines"
            ? "search…"
            : "filter…"
          : files.mode === "lines"
            ? "search in files…"
            : "filter files…"}
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
          onpointerdown={(e) => e.preventDefault()}
          onclick={(e) => pickMode(e, "files")}
          title="Narrow the tree to paths holding the text ({describe(chordFor('find'))})"
          data-testid="mode-files">files</button
        >
        <button
          role="radio"
          aria-checked={files.mode === "lines"}
          class:on={files.mode === "lines"}
          onpointerdown={(e) => e.preventDefault()}
          onclick={(e) => pickMode(e, "lines")}
          title="Search inside the files ({describe(chordFor('findLines'))})"
          data-testid="mode-lines">lines</button
        >
      </span>
    </label>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="more" onkeydown={onMenuKeydown} bind:this={more}>
      <button
        class="tool"
        onclick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More"
        data-testid="changes-menu">⋯</button
      >
      {#if menuOpen}
        <div class="menu" data-card role="menu" use:coversBrowser data-testid="changes-menu-items">
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
          {#if !editing}
            <!-- The viewer's views: in editor mode the tab's own control
                 has them. -->
          <hr />
          <button
            role="menuitemradio"
            aria-checked={view === "diff"}
            disabled={!diffable}
            onclick={() => choose(() => setView("diff"))}
            data-testid="menu-view-diff"
          >
            <span>Diff</span><kbd>{describe(chordFor("view"))}</kbd>
          </button>
          <button
            role="menuitemradio"
            aria-checked={view === "content"}
            disabled={files.selected === null}
            onclick={() => choose(() => setView("content"))}
            data-testid="menu-view-content"
          >
            <span>Whole file</span><kbd>{describe(chordFor("view"))}</kbd>
          </button>
          <button
            role="menuitemradio"
            aria-checked={view === "rendered"}
            disabled={!renderable}
            onclick={() => choose(() => setView("rendered"))}
            data-testid="menu-view-rendered"
          >
            <span>Rendered</span><kbd>{describe(chordFor("view"))}</kbd>
          </button>
          {/if}
          <hr />
          <button role="menuitem" onclick={() => choose(() => refresh())} data-testid="menu-reload">
            <span>Reload</span>
          </button>
          <button role="menuitem" onclick={() => choose(() => openBrowser())} data-testid="menu-browser">
            <span>Browser</span>
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
  {:else if folderInFront}
    <p class="notice" data-testid="folder-notice">
      This folder holds sessions to resume. It is not a project, so there are no changes to show.
    </p>
  {/if}

{/snippet}

<RowMenu />

<!-- One section's rows, on the fold itself or a step in under a group. -->
{#snippet pluginRows(section: PluginSection, deep: boolean)}
  {#each section.rows as row (row.id)}
    {@const facts = factsOf(row)}
    {@const opened = facts.length > 0 && rowOpen(section, row)}
    <li
      id={pluginRowId(section.key, row)}
      class="plugin"
      class:deep
      class:cursor={cursorId === pluginRowId(section.key, row)}
      data-row={row.id}
      data-testid="plugin-row"
    >
      <div class="plugin-line">
        <button
          class="media-row"
          tabindex="-1"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => {
            sectionCursor = sectionEntries.findIndex((entry) => entry.id === pluginRowId(section.key, row));
            pressRow(section, row);
          }}
          title={row.detail ?? row.label}
          aria-expanded={facts.length > 0 ? opened : undefined}
        >
          <span class="row-line">
            {#if facts.length > 0}
              <span class="row-chevron" aria-hidden="true" data-testid="plugin-row-chevron">{opened ? "▾" : "▸"}</span>
            {/if}
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
      </div>
      {#if opened}
        <ul class="facts" data-testid="plugin-facts">
          {#each facts as fact, at (at)}
            <li class="fact" data-state={fact.state ?? "none"} data-testid="plugin-fact">
              <span class="dot" data-state={fact.state ?? "none"}></span>
              <span class="fact-text"
                ><span class="fact-label">{fact.label}</span>{#if fact.text !== null}
                  <span class="fact-detail">{fact.text}</span>{/if}</span
              >
            </li>
          {/each}
        </ul>
      {/if}
    </li>
  {/each}
{/snippet}

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
    font-family: var(--chrome);
    font-size: var(--fold-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
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
    padding: 2px var(--pane-pad) 8px var(--row-indent);
    font-size: 11.5px;
    color: var(--ink-3);
  }

  /* A process row: the text, and a stop button over its end on hover. A
     browser tab's row and a plugin's row carry their own actions the same
     way. */
  .process,
  .browser-tab,
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
  .browser-tab:hover .stop,
  .browser-tab.cursor .stop,
  .plugin:hover .row-actions,
  .plugin.cursor .row-actions {
    opacity: 1;
  }

  .stop:hover {
    color: var(--del);
  }

  /* The word a tab opened by an agent carries in its row's meta. */
  .by {
    font-style: italic;
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
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A further section inside a plugin's fold: a line of its own, lighter
     than a row, with its rows a step in under it. */
  .group-line {
    position: relative;
  }

  .plugin.deep .media-row {
    padding-left: calc(var(--row-indent) + 12px);
  }

  /* A row's own line, which its actions sit over the end of; the facts it
     opens to sit under it, outside their reach. */
  .plugin-line {
    position: relative;
  }

  /* A row that opens to show facts carries a chevron in its indent, so its
     label lines up with the rows that do not. */
  .row-line {
    position: relative;
  }

  .row-chevron {
    position: absolute;
    right: calc(100% + 3px);
    font-size: 10px;
    line-height: 1;
    color: var(--ink-3);
  }

  /* A row's facts, a step in under its label: a state dot, the label, and
     the text after it. */
  .facts {
    list-style: none;
    margin: 0;
    padding: 0 var(--row-pad-x) 4px calc(var(--row-indent) + 13px);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .plugin.deep .facts {
    padding-left: calc(var(--row-indent) + 25px);
  }

  .fact {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--ink-2);
  }

  .fact .dot {
    margin-top: calc((1.4em - var(--dot)) / 2);
  }

  .fact-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .fact-label {
    font-weight: 500;
    color: var(--ink);
  }

  .fact-detail {
    margin-left: 4px;
  }

  .fact[data-state="failed"] .fact-label {
    color: var(--del);
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
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
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
    padding: 0 var(--pane-pad) 6px var(--row-indent);
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
    width: var(--dot);
    height: var(--dot);
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
    min-width: 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    padding: 3px var(--row-pad-x) 3px var(--row-indent);
    border-radius: var(--radius);
    color: var(--ink);
  }

  .media-row:hover,
  .media-row.on {
    background: var(--surface-2);
  }

  /* The tree's cursor, drawn here as it is drawn on the tree's rows, while
     the keyboard is in the pane. */
  .sections.keyed :global(.fold.cursor),
  .sections.keyed .media-row.cursor,
  .sections.keyed .process.cursor,
  .sections.keyed .browser-tab.cursor,
  .sections.keyed .group-line.cursor,
  .sections.keyed .started.cursor,
  .sections.keyed .allowed.cursor,
  .sections.keyed .board-line.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* A plugin's row holds its own lit line and its facts, so its cursor is
     drawn over them both, unbroken by the line's background. */
  .sections.keyed .plugin.cursor::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--accent);
    pointer-events: none;
  }

  .media-caption {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* The line under a row's name, a path more often than not: it breaks
     wherever it must rather than widen the list, and keeps to two lines,
     with the whole of it on the row's tooltip. */
  .media-meta {
    font-family: var(--chrome);
    font-size: 11px;
    line-height: 1.35;
    color: var(--ink-2);
    max-width: 100%;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .started {
    position: relative;
  }

  /* A row's own buttons, over its end on hover, on the row's own colour so
     they read; the name runs under the fade. */
  .row-box {
    position: relative;
    --row-bg: var(--surface);
  }

  .started:hover .row-box {
    --row-bg: var(--surface-2);
  }

  .started:hover .media-row {
    background: var(--surface-2);
  }

  .actions {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px 0 14px;
    background: linear-gradient(to right, transparent, var(--row-bg) 12px);
    opacity: 0;
  }

  .started:hover .actions,
  .actions:focus-within {
    opacity: 1;
  }

  /* Where the cards let a background through, the row's fills are let
     through too: the buttons lay them over the card's paint, so they still
     cover the name, and the fade is that paint faded in. */
  :global(:root[data-cards]) .actions {
    background: var(--paint-surface);
    mask-image: linear-gradient(to right, transparent, black 12px);
  }

  :global(:root[data-cards]) .started:hover .actions {
    background: linear-gradient(var(--surface-2), var(--surface-2)), var(--paint-surface);
  }

  .icon {
    flex: none;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
  }

  .icon.word {
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
  }

  .icon:hover:not(:disabled) {
    color: var(--accent);
  }

  .icon:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The line to type into a session, under the row it goes to. */
  .send {
    display: block;
    width: calc(100% - var(--row-indent) - var(--pane-pad));
    margin: 2px var(--pane-pad) 5px var(--row-indent);
    padding: 3px 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
    outline: none;
  }

  .send::placeholder {
    color: var(--ink-3);
  }

  /* What the starter has been allowed, and what its starts left behind. */
  .board-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 4px var(--pane-pad) 6px var(--row-indent);
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--ink-3);
  }

  .board-line button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .allowed {
    display: inline-flex;
    align-items: center;
  }

  .revoke {
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 12px;
    line-height: 1;
    padding: 0 2px 0 4px;
    cursor: pointer;
  }

  .revoke:hover {
    color: var(--del);
  }

  /* The section of started sessions at the tree's foot: its header in a
     firmer ink than its neighbours', since what is in it waits on its
     sessions, and the actions that end something in the accent. A row's
     buttons show under the cursor as they do on hover. */
  .fold.strong {
    color: var(--ink-2);
  }

  .fold.strong:hover {
    color: var(--ink);
  }

  .head-action.accent {
    color: var(--accent);
  }

  .head-action:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .sections .started.cursor .actions {
    opacity: 1;
  }

  /* Inside the cursor's ring, so the ring stays whole under them. */
  .sections.keyed .started.cursor .actions {
    top: 1px;
    right: 1px;
    bottom: 1px;
  }

  /* Its rows name sessions, in the chrome's type as the sessions pane
     names them. */
  .board-section .media-row,
  .board-section .board-line,
  .board-section .section-empty {
    font-family: var(--chrome);
  }

  .board-section .allowed {
    margin-left: -1px;
    padding: 0 1px 0 3px;
    border-radius: var(--radius-sm);
  }

  .board-ask {
    flex: none;
    padding: 2px var(--pane-pad) 6px var(--row-indent);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field-bg);
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
    font-family: var(--chrome);
    font-size: var(--field-size);
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
    border-radius: var(--radius-sm);
  }

  .modes button,
  .tool {
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 5px;
  }

  .modes button.on {
    color: var(--accent);
    background: var(--paint-surface);
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

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 232px;
    padding: 4px 0;
    background: var(--paint-surface);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
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
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .maker {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .maker:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .maker svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .delete {
    flex: none;
    padding: 8px 8px 0;
  }

  .notice {
    margin: 0;
    padding: 10px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
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

  .split.reviewing,
  .split.editing {
    grid-template-columns: var(--tree-w) var(--splitter-inner-w) minmax(0, 1fr);
  }

  /* Beside the viewer or the editor the tree is a list beside what is read,
     so its column sits a step toward the ground. Alone in the pane it is
     what is read. */
  .split.reviewing:not(.full) > .column,
  .split.editing:not(.treeless, .full) > .column {
    background: var(--paint-well);
  }

  /* Editing in a window that gave up the tree's column: the editor alone. */
  .split.editing.treeless {
    grid-template-columns: minmax(0, 1fr);
  }

  /* A page that asked for the whole pane: the viewer is the only column. */
  .split.full {
    grid-template-columns: 1fr;
  }
</style>

<script lang="ts">
  import { buildTree, flatten, parentOf, type Row, type TreeNode } from "$lib/tree";
  import { files, isOpen, toggleDir, visible } from "$lib/files.svelte";
  import { layout, overlayHoldsKeyboard } from "$lib/layout.svelte";
  import { untrack } from "svelte";

  /** Rows that follow the tree's own in the same column, the media section
      under it, which the tree's one cursor runs on into: the keyboard stays
      on the tree, and these are driven from here. */
  export interface Beyond {
    /** The rows' element ids, in order. */
    ids: string[];
    /** Which of them the cursor is on, or -1 when it is in the tree. */
    cursor: number;
    onCursor: (index: number) => void;
    /** Enter or Space on one. */
    activate: (index: number) => void;
    /** Left folds, Right unfolds, as they close and open a folder. */
    fold: (index: number, open: boolean) => void;
  }

  /** A name field in the tree: for a new file or folder, in place in the
      folder it goes in, or over a row being renamed. */
  export interface NameField {
    /** The folder a new one goes in, null for the top. */
    folder: string | null;
    /** The row being renamed, when it is a rename. */
    rename: string | null;
    /** A folder shown open before it exists, the field inside it. */
    pending: string | null;
    folderIcon: boolean;
    value: string;
    problem: string | null;
    label: string;
    /** What goes in the empty field, saying what it is for. */
    placeholder: string;
    onInput: (value: string) => void;
    onCommit: () => void;
    onCancel: () => void;
    /** The field lost the keyboard. */
    onLeave: () => void;
  }

  interface Props {
    /** Called when a file row is activated. Folders are handled here. */
    onOpen: (path: string) => void;
    /** A double-click on a file row. */
    onDouble?: (path: string) => void;
    /** Whether a file has edits not yet saved: its row carries a dot. */
    unsaved?: (path: string) => boolean;
    /** A click on the tree itself, below the last row. */
    onBlank?: () => void;
    /** The pane has focus: the keyboard belongs on the tree, so the arrows
        work without a click first. */
    focused?: boolean;
    beyond?: Beyond;
    field?: NameField | null;
    /** A right-click on a row, or on the tree below its rows with no path. */
    onMenu?: (path: string | null, dir: boolean, x: number, y: number) => void;
    /** The row the cursor is on, once the user has moved it, and whenever
        they move it after. */
    onCursorRow?: (row: { path: string; dir: boolean } | null) => void;
    /** A row marked while a menu for it is open. */
    marked?: string | null;
  }

  let {
    onOpen,
    onDouble,
    unsaved,
    onBlank,
    focused = false,
    beyond,
    field = null,
    onMenu,
    onCursorRow,
    marked = null,
  }: Props = $props();

  let root: HTMLDivElement;

  $effect(() => {
    // Read so a request to take the keyboard again re-runs this: the
    // viewer's close leaves the document's focus on nothing.
    layout.focusRequest;
    if (!focused || !root || overlayHoldsKeyboard()) return;
    const active = document.activeElement;
    if (active === root || root.contains(active)) return;
    // Another control of the same pane, the filter field most of all, keeps
    // the keyboard it was given; the tree takes it from anywhere else, the
    // editor beside it included.
    if (
      active !== null &&
      active.closest(".cm-editor") === null &&
      root.closest("section[data-pane]")?.contains(active)
    )
      return;
    root.focus();
  });

  let rows = $derived(flatten(buildTree(visible()), isOpen));

  // Roving focus lives on the tree, not on every row: one tab stop, and arrow
  // keys move a cursor within it. That is what makes a few hundred rows
  // navigable without tabbing through all of them.
  let cursor = $state(0);

  $effect(() => {
    const selected = files.selected;
    if (selected === null) return;
    const at = rows.findIndex((row) => row.node.path === selected);
    if (at !== -1) cursor = at;
  });

  let total = $derived(rows.length + (beyond?.ids.length ?? 0));

  // The rows shrink under the cursor when a folder or the section under
  // the tree folds: the cursor stays on the last row there is.
  $effect(() => {
    if (cursor > total - 1) cursor = Math.max(0, total - 1);
  });

  // A row going from under the cursor leaves it on the row that took its
  // place in the tree, or the last row of the tree, rather than letting it
  // run on into the sections beneath.
  let cursorPath: string | null = null;
  $effect(() => {
    const now = rows;
    untrack(() => {
      if (cursorPath === null || now.some((row) => row.node.path === cursorPath)) return;
      if (cursor >= now.length && now.length > 0) cursor = now.length - 1;
    });
  });
  $effect(() => {
    const row = cursor < rows.length ? rows[cursor] : undefined;
    cursorPath = row?.node.path ?? null;
  });

  /** The tree's row under the cursor, none when the cursor is beyond. */
  let active = $derived(cursor < rows.length ? rows[cursor] : undefined);
  /** Which of the rows beyond the cursor is on, -1 in the tree. */
  let beyondAt = $derived(cursor >= rows.length ? cursor - rows.length : -1);

  // The pane moves the cursor onto a row beyond, when what the agent
  // presented opens; the cursor's own moves are told back the same way.
  $effect(() => {
    const want = beyond?.cursor ?? -1;
    if (want >= 0) untrack(() => moveTo(rows.length + want));
  });
  $effect(() => {
    const at = beyondAt;
    untrack(() => beyond?.onCursor(at));
  });

  // Where a new file or folder is named: after the last row inside the
  // folder it goes in, a step in from it, under a folder shown before it
  // exists when there is one. A folder the tree draws as part of a longer
  // row, or not at all, puts the field at the end, its path written before.
  let placement = $derived.by(() => {
    if (field === null || field.rename !== null) return null;
    const host = field.pending ?? field.folder;
    if (host === null) return { after: rows.length - 1, depth: 0, prefix: "", virtual: null };
    let at = -1;
    for (let i = 0; i < rows.length; i++) {
      const node = rows[i].node;
      if (!node.dir) continue;
      if (node.path === host || host.startsWith(`${node.path}/`)) {
        if (at === -1 || node.path.length > rows[at].node.path.length) at = i;
      }
    }
    if (at === -1) {
      return field.pending === null
        ? { after: rows.length - 1, depth: 0, prefix: `${host}/`, virtual: null }
        : { after: rows.length - 1, depth: 1, prefix: "", virtual: { name: host, depth: 0 } };
    }
    const shown = rows[at];
    let end = at + 1;
    while (end < rows.length && rows[end].depth > shown.depth) end++;
    if (shown.node.path === host) {
      return { after: end - 1, depth: shown.depth + 1, prefix: "", virtual: null };
    }
    const rest = host.slice(shown.node.path.length + 1);
    if (field.pending !== null && field.pending === host) {
      return {
        after: end - 1,
        depth: shown.depth + 2,
        prefix: "",
        virtual: { name: rest, depth: shown.depth + 1 },
      };
    }
    return { after: end - 1, depth: shown.depth + 1, prefix: `${rest}/`, virtual: null };
  });

  /** The user has put the cursor somewhere: by a key, a click or the menu.
      Until then it sits on the first row by default and says nothing. */
  let touched = $state(false);

  // Tells whoever asked where the user put the cursor, for where a new
  // file goes.
  $effect(() => {
    const row = active;
    if (!touched) return;
    untrack(() => onCursorRow?.(row === undefined ? null : { path: row.node.path, dir: row.node.dir }));
  });

  function menu(e: MouseEvent, row: Row | null) {
    if (onMenu === undefined) return;
    e.preventDefault();
    if (row !== null) {
      cursor = rows.indexOf(row);
      touched = true;
    }
    root.focus();
    onMenu(row?.node.path ?? null, row?.node.dir ?? true, e.clientX, e.clientY);
  }

  /** The field takes the keyboard as it opens, with the name selected up to
      its extension, so typing replaces the name and keeps the kind. */
  function takeKeys(node: HTMLInputElement) {
    node.focus();
    const dot = node.value.lastIndexOf(".");
    node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
  }

  function fieldKeys(e: KeyboardEvent) {
    // Every key is the field's: the tree's arrows and Enter stand down.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      field?.onCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      field?.onCancel();
    }
  }

  function rowId(row: Row) {
    return `tree-${row.node.path}`;
  }

  function idAt(index: number): string | undefined {
    if (index < rows.length) return rowId(rows[index]);
    return beyond?.ids[index - rows.length];
  }

  function activate(node: TreeNode) {
    if (node.dir) toggleDir(node);
    else onOpen(node.path);
  }

  function moveTo(index: number) {
    cursor = Math.max(0, Math.min(index, total - 1));
    const id = idAt(cursor);
    if (id !== undefined) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(e: KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) touched = true;
    if (!active) {
      if (beyond === undefined || beyondAt < 0) return;
      // On a row beyond the tree: the arrows still walk, Home comes back
      // up, and Enter, Left and Right are the section's own.
      switch (e.key) {
        case "ArrowDown":
          moveTo(cursor + 1);
          break;
        case "ArrowUp":
          moveTo(cursor - 1);
          break;
        case "Home":
          moveTo(0);
          break;
        case "End":
          moveTo(total - 1);
          break;
        case "Enter":
        case " ":
          beyond.activate(beyondAt);
          break;
        case "ArrowLeft":
          beyond.fold(beyondAt, false);
          break;
        case "ArrowRight":
          beyond.fold(beyondAt, true);
          break;
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    const node = active.node;

    switch (e.key) {
      case "ArrowDown":
        moveTo(cursor + 1);
        break;
      case "ArrowUp":
        moveTo(cursor - 1);
        break;
      case "ArrowRight":
        // Open a closed folder, then step into it. A file has nowhere to go.
        if (node.dir && !isOpen(node)) toggleDir(node);
        else if (node.dir) moveTo(cursor + 1);
        else return;
        break;
      case "ArrowLeft": {
        if (node.dir && isOpen(node)) {
          toggleDir(node);
          break;
        }
        const parent = parentOf(node.path);
        if (parent === null) return;
        const at = rows.findIndex((row) => row.node.path === parent);
        if (at === -1) return;
        moveTo(at);
        break;
      }
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(total - 1);
        break;
      case "Enter":
      case " ":
        activate(node);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
</script>

<div
  class="tree no-select"
  role="tree"
  aria-label="Files"
  aria-activedescendant={idAt(cursor)}
  aria-owns={beyond?.ids.join(" ")}
  tabindex="0"
  bind:this={root}
  onkeydown={onKeydown}
  onclick={(e) => {
    if (e.target === e.currentTarget) onBlank?.();
  }}
  oncontextmenu={(e) => {
    if (e.target === e.currentTarget) menu(e, null);
  }}
  data-testid="file-tree"
>
  {#snippet nameInput(depth: number, prefix: string)}
    <div class="row naming" style:padding-left="{8 + depth * 13}px" data-testid="name-row">
      <span class="twist">{field?.folderIcon ? "▸" : "·"}</span>
      <span class="field-box">
        {#if prefix !== ""}<span class="prefix">{prefix}</span>{/if}
        <input
          value={field?.value ?? ""}
          use:takeKeys
          oninput={(e) => field?.onInput((e.currentTarget as HTMLInputElement).value)}
          onkeydown={fieldKeys}
          onblur={() => field?.onLeave()}
          placeholder={field?.placeholder}
          aria-label={field?.label}
          aria-invalid={field?.problem !== null}
          spellcheck="false"
          autocomplete="off"
          data-testid="name-field"
        />
      </span>
    </div>
    {#if field?.problem}
      <p class="problem" style:padding-left="{8 + depth * 13 + 20}px" role="alert" data-testid="name-problem">
        {field.problem}
      </p>
    {/if}
  {/snippet}
  {#snippet placed()}
    {#if placement !== null}
      {#if placement.virtual !== null}
        <div class="row dir pending" style:padding-left="{8 + placement.virtual.depth * 13}px" data-testid="pending-folder">
          <span class="twist">▾</span>
          <span class="name">{placement.virtual.name}</span>
        </div>
      {/if}
      {@render nameInput(placement.depth, placement.prefix)}
    {/if}
  {/snippet}
  {#if placement !== null && placement.after === -1}
    {@render placed()}
  {/if}
  {#each rows as row, index (row.node.path)}
    {@const node = row.node}
    <!-- Keyboard handling belongs to the tree, not to each row: that is the
         ARIA tree pattern, and one tab stop is what keeps a few hundred rows
         navigable. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      id={rowId(row)}
      class="row"
      class:dir={node.dir}
      class:selected={!node.dir && files.selected === node.path}
      class:cursor={active === row}
      class:quiet={!node.hasChange}
      class:marked={marked === node.path}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={!node.dir && files.selected === node.path}
      aria-expanded={node.dir ? isOpen(node) : undefined}
      style:padding-left="{8 + row.depth * 13}px"
      onclick={() => {
        cursor = rows.indexOf(row);
        touched = true;
        activate(node);
      }}
      ondblclick={() => {
        if (!node.dir) onDouble?.(node.path);
      }}
      oncontextmenu={(e) => menu(e, row)}
    >
      {#if node.dir}
        <span class="twist">{isOpen(node) ? "▾" : "▸"}</span>
      {:else}
        <span class="status" data-status={node.entry?.status ?? "-"}>
          {node.entry?.status ?? "·"}
        </span>
      {/if}

      {#if field !== null && field.rename === node.path}
        <span class="field-box">
          <input
            value={field.value}
            use:takeKeys
            oninput={(e) => field?.onInput((e.currentTarget as HTMLInputElement).value)}
            onkeydown={fieldKeys}
            onblur={() => field?.onLeave()}
            onclick={(e) => e.stopPropagation()}
            aria-label={field.label}
            aria-invalid={field.problem !== null}
            spellcheck="false"
            autocomplete="off"
            data-testid="name-field"
          />
        </span>
      {:else}
        <span class="name">{node.name}</span>
      {/if}

      {#if !node.dir && unsaved?.(node.path)}
        <span class="unsaved" title="Unsaved" data-testid="tree-unsaved"></span>
      {:else if !node.dir && node.entry}
        <span class="stat">
          {#if node.entry.add}<span class="add">+{node.entry.add}</span>{/if}
          {#if node.entry.del}<span class="del">−{node.entry.del}</span>{/if}
        </span>
      {/if}
    </div>
    {#if field !== null && field.rename === node.path && field.problem}
      <p class="problem" style:padding-left="{8 + row.depth * 13 + 20}px" role="alert" data-testid="name-problem">
        {field.problem}
      </p>
    {/if}
    {#if placement !== null && placement.after === index}
      {@render placed()}
    {/if}
  {/each}
</div>

<style>
  .tree {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 6px 0;
    font-family: var(--chrome);
    font-size: var(--row-size);
    line-height: 1.5;
  }

  .tree:focus-visible {
    outline: none;
  }

  /* The first column is the twist or the status letter, at a width of its
     own so no letter ever reaches the name beside it. */
  .row {
    display: grid;
    grid-template-columns: var(--tree-glyph) 1fr auto;
    gap: 6px;
    align-items: baseline;
    margin: 0 var(--row-inset);
    padding-right: var(--row-pad-x);
    border-radius: var(--radius);
    color: var(--ink-2);
    cursor: pointer;
    white-space: nowrap;
  }

  .row:hover {
    background: var(--surface-2);
  }

  /* A folder with nothing changed beneath it is scenery while you are reading
     a diff, so it recedes rather than competing with the files that matter. */
  .row.quiet .name {
    color: var(--ink-3);
  }

  .row.dir .name {
    color: var(--ink-2);
  }

  .row.selected {
    background: var(--accent-soft);
  }

  .row.selected .name {
    color: var(--accent);
  }

  /* The keyboard cursor is distinct from the open file: you can walk the tree
     without changing what the viewer is showing. */
  .tree:focus-visible .row.cursor {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* The row a menu is open for. */
  .row.marked {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .twist,
  .status {
    text-align: center;
  }

  .twist {
    color: var(--ink-3);
  }

  .status[data-status="M"],
  .status[data-status="A"] {
    color: var(--add);
  }

  .status[data-status="D"] {
    color: var(--del);
  }

  .status[data-status="R"],
  .status[data-status="-"] {
    color: var(--ink-3);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stat {
    color: var(--ink-3);
  }

  /* The name field in place of a row's name: the row's height, ringed in
     the accent. */
  .row.naming,
  .row.naming:hover {
    background: none;
  }

  /* As tall as the row it stands in: the ring is drawn outside the line,
     so nothing below moves when the field opens. */
  .field-box {
    display: flex;
    align-items: baseline;
    min-width: 0;
    grid-column: 2 / -1;
    padding: 0 6px;
    margin: 0 -6px;
    border-radius: var(--radius-sm);
    background: var(--field-bg);
    box-shadow: 0 0 0 1.5px var(--accent);
    line-height: inherit;
  }

  .field-box input {
    flex: 1;
    min-width: 0;
    height: 1.5em;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    line-height: inherit;
    color: var(--ink);
    outline: none;
  }

  .field-box input::placeholder {
    color: var(--ink-3);
  }

  .prefix {
    color: var(--ink-3);
  }

  .row.pending .name {
    color: var(--ink-2);
  }

  .problem {
    margin: 2px var(--row-inset) 4px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--del);
    white-space: normal;
  }

  /* Edits not yet saved, where the counts stand. */
  .unsaved {
    align-self: center;
    justify-self: end;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ink-2);
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }
</style>

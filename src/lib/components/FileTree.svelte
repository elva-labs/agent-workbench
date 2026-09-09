<script lang="ts">
  import { buildTree, flatten, parentOf, type Row, type TreeNode } from "$lib/tree";
  import { files, isOpen, toggleDir, visible } from "$lib/files.svelte";
  import { layout } from "$lib/layout.svelte";
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

  interface Props {
    /** Called when a file row is activated. Folders are handled here. */
    onOpen: (path: string) => void;
    /** A click on the tree itself, below the last row. */
    onBlank?: () => void;
    /** The pane has focus: the keyboard belongs on the tree, so the arrows
        work without a click first. */
    focused?: boolean;
    beyond?: Beyond;
  }

  let { onOpen, onBlank, focused = false, beyond }: Props = $props();

  let root: HTMLDivElement;

  $effect(() => {
    // Read so a request to take the keyboard again re-runs this: the
    // viewer's close leaves the document's focus on nothing.
    layout.focusRequest;
    if (!focused || !root) return;
    const active = document.activeElement;
    if (active === root || root.contains(active)) return;
    // Another control of the same pane, the filter field most of all, keeps
    // the keyboard it was given; the tree takes it from anywhere else.
    if (active !== null && root.closest("section[data-pane]")?.contains(active)) return;
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
  data-testid="file-tree"
>
  {#each rows as row (row.node.path)}
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
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={!node.dir && files.selected === node.path}
      aria-expanded={node.dir ? isOpen(node) : undefined}
      style:padding-left="{8 + row.depth * 13}px"
      onclick={() => {
        cursor = rows.indexOf(row);
        activate(node);
      }}
    >
      {#if node.dir}
        <span class="twist">{isOpen(node) ? "▾" : "▸"}</span>
      {:else}
        <span class="status" data-status={node.entry?.status ?? "-"}>
          {node.entry?.status ?? "·"}
        </span>
      {/if}

      <span class="name">{node.name}</span>

      {#if !node.dir && node.entry}
        <span class="stat">
          {#if node.entry.add}<span class="add">+{node.entry.add}</span>{/if}
          {#if node.entry.del}<span class="del">−{node.entry.del}</span>{/if}
        </span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .tree {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 6px 0;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
  }

  .tree:focus-visible {
    outline: none;
  }

  .row {
    display: grid;
    grid-template-columns: 14px 1fr auto;
    gap: 6px;
    align-items: baseline;
    padding-right: var(--pane-pad);
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

  .twist {
    color: var(--ink-3);
    text-align: center;
  }

  .status[data-status="M"],
  .status[data-status="A"] {
    color: var(--add);
    text-align: center;
  }

  .status[data-status="D"] {
    color: var(--del);
    text-align: center;
  }

  .status[data-status="R"],
  .status[data-status="-"] {
    color: var(--ink-3);
    text-align: center;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stat {
    color: var(--ink-3);
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }
</style>

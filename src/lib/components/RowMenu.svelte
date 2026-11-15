<script lang="ts">
  /**
   * The menu a right-click on a row of the tree opens in editor mode: a new
   * file or folder where the row is, the row renamed or deleted, its path
   * copied, and the file shown in the platform's file manager for a project
   * on this machine. On the tree below its rows, only the first two, at the
   * top. The arrows walk it, Enter picks, Escape puts it away and the
   * keyboard goes back to the tree.
   */
  import { untrack } from "svelte";
  import {
    askDelete,
    canReveal,
    closeMenu,
    copyPath,
    fileOps,
    newFile,
    newFolder,
    rename,
    revealInFiles,
    revealLabel,
  } from "$lib/fileOps.svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import { parentOf } from "$lib/tree";

  let menu = $derived(fileOps.menu);
  let box = $state<HTMLDivElement | null>(null);

  interface Item {
    id: string;
    label: string;
    chord?: string;
    danger?: boolean;
    run: () => void;
  }

  /** The items, in groups the menu draws a rule between. */
  let groups = $derived.by((): Item[][] => {
    if (menu === null) return [];
    const at = menu;
    const folder = at.path === null ? null : at.dir ? at.path : parentOf(at.path);
    const making: Item[] = [
      { id: "new-file", label: "New file", chord: describe(chordFor("file.new")), run: () => newFile(folder) },
      { id: "new-folder", label: "New folder", run: () => newFolder(folder) },
    ];
    if (at.path === null) return [making];
    const path = at.path;
    const changing: Item[] = [
      { id: "rename", label: "Rename", run: () => rename(path, at.dir) },
      { id: "delete", label: "Delete", danger: true, run: () => askDelete(path, at.dir) },
    ];
    const pointing: Item[] = [{ id: "copy-path", label: "Copy path", run: () => void copyPath(path) }];
    if (canReveal()) pointing.push({ id: "reveal", label: revealLabel(), run: () => void revealInFiles(path) });
    return [making, changing, pointing];
  });
  let items = $derived(groups.flat());
  let cursor = $state(0);

  // Opened: the cursor on the first item, and the keyboard in the menu.
  $effect(() => {
    if (menu === null) return;
    untrack(() => {
      cursor = 0;
      queueMicrotask(() => box?.focus());
    });
  });

  /** Kept inside the window: a menu opened near an edge opens the other way. */
  let place = $derived.by(() => {
    if (menu === null) return { left: 0, top: 0 };
    const width = 210;
    const height = 34 + items.length * 26;
    return {
      left: Math.min(menu.x, window.innerWidth - width - 8),
      top: menu.y + height > window.innerHeight - 8 ? Math.max(8, menu.y - height) : menu.y,
    };
  });

  function pick(item: Item) {
    closeMenu();
    item.run();
  }

  function keys(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "ArrowDown") cursor = (cursor + 1) % items.length;
    else if (e.key === "ArrowUp") cursor = (cursor - 1 + items.length) % items.length;
    else if (e.key === "Home") cursor = 0;
    else if (e.key === "End") cursor = items.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      const item = items[cursor];
      if (item !== undefined) pick(item);
    } else if (e.key === "Escape") {
      closeMenu();
      (document.querySelector("[data-testid='file-tree']") as HTMLElement | null)?.focus();
    } else return;
    e.preventDefault();
  }
</script>

{#if menu !== null}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" onclick={closeMenu} oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}></div>
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label="File"
    bind:this={box}
    onkeydown={keys}
    style:left="{place.left}px"
    style:top="{place.top}px"
    use:coversBrowser
    data-testid="row-menu"
  >
    {#each groups as group, g (g)}
      {#if g > 0}<hr />{/if}
      {#each group as item (item.id)}
        <button
          role="menuitem"
          class:on={items[cursor] === item}
          class:danger={item.danger}
          tabindex="-1"
          onpointerenter={() => (cursor = items.indexOf(item))}
          onclick={() => pick(item)}
          data-testid="row-menu-{item.id}"
        >
          <span>{item.label}</span>
          {#if item.chord}<kbd>{item.chord}</kbd>{/if}
        </button>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
  }

  .menu {
    position: fixed;
    z-index: 31;
    width: 210px;
    padding: 4px;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    box-shadow: 0 12px 32px color-mix(in srgb, black 28%, transparent);
    outline: none;
  }

  hr {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 4px 0;
  }

  button {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink);
    text-align: left;
    white-space: nowrap;
    cursor: default;
  }

  button.on {
    background: var(--accent-soft);
  }

  button.danger {
    color: var(--del);
  }

  kbd {
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
  }
</style>

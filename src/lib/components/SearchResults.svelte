<script lang="ts">
  import type { GrepHit } from "$lib/core";
  import { files } from "$lib/files.svelte";

  /**
   * Hits from a lines search, in the tree's place: a row per file with its
   * count, then a row per hit with the line number and the line, the match
   * marked. A hit opens the file there.
   */
  interface Props {
    onOpen: (path: string, line: number) => void;
  }

  let { onOpen }: Props = $props();

  interface Group {
    path: string;
    hits: GrepHit[];
  }

  let groups = $derived.by(() => {
    const out: Group[] = [];
    for (const hit of files.hits) {
      const last = out[out.length - 1];
      if (last?.path === hit.path) last.hits.push(hit);
      else out.push({ path: hit.path, hits: [hit] });
    }
    return out;
  });

  /** The line split around the first match, so the match can be marked. */
  function parts(text: string): { before: string; match: string; after: string } {
    const query = files.query.trim();
    const at = query === "" ? -1 : text.toLowerCase().indexOf(query.toLowerCase());
    if (at === -1) return { before: text, match: "", after: "" };
    return {
      before: text.slice(0, at),
      match: text.slice(at, at + query.length),
      after: text.slice(at + query.length),
    };
  }

  function onKeydown(e: KeyboardEvent) {
    // Up and Down walk the hits, which are the buttons in here.
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button.hit"),
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[at + (e.key === "ArrowDown" ? 1 : -1)] ?? buttons[at === -1 ? 0 : at];
    next?.focus();
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="results" onkeydown={onKeydown} data-testid="search-results">
  {#if files.searching && files.hits.length === 0}
    <p class="note">Searching…</p>
  {:else if files.hits.length === 0}
    <p class="note">Nothing matches.</p>
  {/if}
  {#each groups as group (group.path)}
    <div class="file" data-testid="search-file">
      <span class="path">{group.path}</span>
      <span class="count">{group.hits.length}</span>
    </div>
    {#each group.hits as hit (hit.line)}
      {@const p = parts(hit.text)}
      <button class="hit" onclick={() => onOpen(hit.path, hit.line)} data-testid="search-hit">
        <span class="num">{hit.line}</span>
        <span class="text">{p.before}<mark>{p.match}</mark>{p.after}</span>
      </button>
    {/each}
  {/each}
  {#if files.hitsTruncated}
    <p class="note" data-testid="search-truncated">
      Cut short at {files.hits.length}. A narrower query shows the rest.
    </p>
  {/if}
</div>

<style>
  .results {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 6px 0;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
  }

  .note {
    margin: 0;
    padding: 6px var(--pane-pad);
    font-family: var(--sans);
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .file {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px var(--pane-pad) 2px;
    color: var(--ink);
  }

  .file .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex: none;
    font-size: 10px;
    color: var(--ink-3);
  }

  .hit {
    display: flex;
    width: 100%;
    gap: 10px;
    align-items: baseline;
    padding: 1px var(--pane-pad) 1px 20px;
    border: 0;
    background: none;
    font: inherit;
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }

  .hit:hover,
  .hit:focus-visible {
    background: var(--surface-2);
    outline: none;
  }

  .num {
    flex: none;
    min-width: 3ch;
    text-align: right;
    color: var(--ink-3);
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }

  mark {
    background: var(--accent-soft);
    color: var(--accent);
  }
</style>

<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import {
    basename,
    canDiff,
    files,
    listed,
    select,
    selectedEntry,
    setScope,
    setView,
  } from "$lib/files.svelte";
  import { enterReview, exitReview, layout } from "$lib/layout.svelte";

  let entries = $derived(listed());
  let reviewing = $derived(layout.mode === "reviewing");
  let diffable = $derived(canDiff(selectedEntry()));

  function open(path: string) {
    select(path);
    enterReview();
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

  {#if reviewing}
    <div class="strip" role="tablist" aria-label="Open a file">
      {#each entries as file (file.path)}
        <button
          class="chip"
          role="tab"
          aria-selected={files.selected === file.path}
          class:on={files.selected === file.path}
          onclick={() => select(file.path)}
        >
          <span class="status" data-status={file.status ?? "-"}>{file.status ?? "·"}</span>
          {basename(file.path)}
        </button>
      {/each}
    </div>
    <FileViewer />
  {:else}
    <ul class="files">
      {#each entries as file (file.path)}
        <li>
          <button onclick={() => open(file.path)}>
            <span class="status" data-status={file.status ?? "-"}>{file.status ?? "·"}</span>
            <span class="path">{file.path}</span>
            <span class="stat">
              {#if file.add}<span class="add">+{file.add}</span>{/if}
              {#if file.del}<span class="del">−{file.del}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
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

  /* The list becomes a strip once the viewer has the pane: same files, same
     order, still one click away, but no longer the reason the pane exists. */
  .strip {
    display: flex;
    gap: 1px;
    overflow-x: auto;
    padding: 6px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
    scrollbar-width: thin;
  }

  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    padding: 3px 9px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ink-3);
    cursor: pointer;
    white-space: nowrap;
  }

  .chip:hover {
    color: var(--ink-2);
  }

  .chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .files {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 6px 0;
  }

  .files button {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    padding: 4px var(--pane-pad);
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }

  .files button:hover {
    background: var(--surface-2);
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

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

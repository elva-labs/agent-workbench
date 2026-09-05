<script lang="ts">
  import { closeViewer, effectiveView, files, selectedEntry } from "$lib/files.svelte";

  // Phase 2 swaps this rendering for @codemirror/merge on a diff and a
  // read-only EditorView on content, which is also where side-by-side comes
  // from: the merge view does two columns natively, so hand-rolling one here
  // would be thrown away. The chrome around it is what matters now.
  let entry = $derived(selectedEntry());
  let view = $derived(effectiveView());
  let diff = $derived(files.diff);
  let content = $derived(files.content);

  let viewer: HTMLDivElement;

  /** The line a search hit asked for, when it is this file's. */
  let target = $derived(
    entry !== null && files.target?.path === entry.path ? files.target.line : null,
  );

  // Once the lines are there, bring the target into view. Bound to what is
  // rendered, so it runs again when the content arrives after the target.
  $effect(() => {
    target;
    content;
    diff;
    if (target === null || !viewer) return;
    queueMicrotask(() =>
      viewer.querySelector(".target")?.scrollIntoView({ block: "center" }),
    );
  });
</script>

<div class="viewer" data-testid="viewer" data-view={view} bind:this={viewer}>
  {#if entry !== null}
    <div class="bar">
      <span class="path" title={entry.path}>{entry.path}</span>
      <button class="close" onclick={closeViewer} aria-label="Close the viewer">Esc</button>
    </div>
  {/if}
  {#if entry === null}
    <p class="empty">Pick a file to read it.</p>
  {:else if entry.binary}
    <p class="empty">Binary file, not shown.</p>
  {:else if view === "diff" && diff !== null && diff.lines.length > 0}
    <table class="lines diff">
      <tbody>
        {#each diff!.lines as line, i (i)}
          <tr class={line.kind} class:target={target !== null && line.new === target}>
            <td class="num">{line.old ?? ""}</td>
            <td class="num">{line.new ?? ""}</td>
            <td class="sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
            <td class="text">{line.text}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if content !== null && content.lines.length > 0}
    <table class="lines">
      <tbody>
        {#each content!.lines as line, i (i)}
          <tr class:target={target === i + 1}>
            <td class="num">{i + 1}</td>
            <td class="text">{line}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if files.loading}
    <p class="empty">Reading…</p>
  {:else if content?.binary || diff?.binary}
    <p class="empty">Binary file, not shown.</p>
  {:else}
    <p class="empty">
      {entry.status === "D" ? "This file was deleted." : "Nothing to show."}
    </p>
  {/if}

  {#if diff?.truncated || content?.truncated}
    <p class="empty">Cut short: this file is too long to render in full.</p>
  {/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    position: sticky;
    top: 0;
    background: var(--surface);
    z-index: 1;
  }

  .bar .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
  }

  .close {
    flex: none;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 8px;
    border: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .close:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  tr.target td {
    background: var(--accent-soft);
  }

  .viewer {
    height: 100%;
    overflow: auto;
    background: var(--surface);
  }

  .lines {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.55;
  }

  td {
    padding: 0 6px;
    vertical-align: top;
    white-space: pre;
  }

  .num {
    width: 1%;
    text-align: right;
    color: var(--ink-3);
    user-select: none;
    font-variant-numeric: tabular-nums;
  }

  .sign {
    width: 1%;
    text-align: center;
    user-select: none;
    color: var(--ink-3);
  }

  .text {
    color: var(--ink-2);
    width: 100%;
  }

  .diff .add {
    background: color-mix(in srgb, var(--add) 12%, transparent);
  }

  .diff .add .text,
  .diff .add .sign {
    color: var(--add);
  }

  .diff .del {
    background: color-mix(in srgb, var(--del) 12%, transparent);
  }

  .diff .del .text,
  .diff .del .sign {
    color: var(--del);
  }

  .diff .hunk .text {
    color: var(--accent);
  }

  .diff .hunk {
    background: var(--accent-soft);
  }

  .empty {
    margin: 0;
    padding: 16px var(--pane-pad);
    font-size: 13px;
    color: var(--ink-3);
  }
</style>

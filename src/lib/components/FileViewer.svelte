<script lang="ts">
  import { effectiveView, selectedEntry } from "$lib/files.svelte";

  // Phase 2 swaps this rendering for @codemirror/merge on a diff and a
  // read-only EditorView on content, which is also where side-by-side comes
  // from: the merge view does two columns natively, so hand-rolling one here
  // would be thrown away. The chrome around it is what matters now.
  let entry = $derived(selectedEntry());
  let view = $derived(effectiveView());
</script>

<div class="viewer" data-testid="viewer" data-view={view}>
  {#if entry === null}
    <p class="empty">Pick a file to read it.</p>
  {:else if entry.binary}
    <p class="empty">Binary file, not shown.</p>
  {:else if view === "diff" && entry.diff}
    <table class="lines diff">
      <tbody>
        {#each entry.diff as line, i (i)}
          <tr class={line.kind}>
            <td class="num">{line.old ?? ""}</td>
            <td class="num">{line.new ?? ""}</td>
            <td class="sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
            <td class="text">{line.text}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if entry.content}
    <table class="lines">
      <tbody>
        {#each entry.content as line, i (i)}
          <tr>
            <td class="num">{i + 1}</td>
            <td class="text">{line}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="empty">
      {entry.status === "D" ? "This file was deleted." : "No content loaded."}
    </p>
  {/if}
</div>

<style>
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

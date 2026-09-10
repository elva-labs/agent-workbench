<script lang="ts">
  import MediaStack from "$lib/components/MediaStack.svelte";
  import { closeViewer, effectiveView, files, pick, selectedEntry } from "$lib/files.svelte";

  // Phase 2 swaps this rendering for @codemirror/merge on a diff and a
  // read-only EditorView on content, which is also where side-by-side comes
  // from: the merge view does two columns natively, so hand-rolling one here
  // would be thrown away. The chrome around it is what matters now.
  let entry = $derived(selectedEntry());
  let view = $derived(effectiveView());
  let diff = $derived(files.diff);
  let content = $derived(files.content);

  let viewer: HTMLDivElement;

  /** The place asked for, when it is this file's: a line or a range. */
  let target = $derived(
    entry !== null && files.target?.path === entry.path ? files.target : null,
  );
  const marked = (line: number | null | undefined) =>
    target !== null &&
    line !== null &&
    line !== undefined &&
    line >= target.line &&
    line <= (target.to ?? target.line);

  /** The lines the user selected, when they are this file's. */
  let picked = $derived(
    entry !== null && files.picked?.path === entry.path ? files.picked : null,
  );
  const inPick = (line: number | null | undefined) =>
    picked !== null && line !== null && line !== undefined && line >= picked.from && line <= picked.to;

  // The mouse selection, read off the document: the rows it touches make
  // the pick, which outlives the selection itself. A click in the viewer
  // lets the pick go; a click anywhere else, the agent above all, keeps it.
  $effect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!viewer || selection === null || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (range.collapsed) {
        if (viewer.contains(range.startContainer)) pick(null);
        return;
      }
      let from: number | null = null;
      let to: number | null = null;
      for (const row of viewer.querySelectorAll<HTMLTableRowElement>("tr[data-line]")) {
        const own = document.createRange();
        own.selectNodeContents(row);
        // Touched with some of its text, not met at an edge: the selection
        // starts before the row ends and ends after the row starts.
        const touched =
          range.compareBoundaryPoints(Range.END_TO_START, own) === -1 &&
          range.compareBoundaryPoints(Range.START_TO_END, own) === 1;
        if (!touched) continue;
        const line = Number(row.dataset.line);
        from = from === null ? line : Math.min(from, line);
        to = to === null ? line : Math.max(to, line);
      }
      if (from !== null && to !== null) pick({ from, to });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  });

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

<div class="viewer" data-testid="viewer" data-view={files.media !== null ? "media" : view} bind:this={viewer}>
  {#if files.media !== null}
    <div class="bar">
      <span class="path" title={files.media.files.join("\n")} data-testid="media-caption"
        >{files.media.caption ?? `${files.media.files.length} ${files.media.files.length === 1 ? "file" : "files"}`}</span
      >
      <button class="close" onclick={closeViewer} aria-label="Close the viewer">Esc</button>
    </div>
  {:else if entry !== null}
    <div class="bar">
      <span class="path" title={entry.path}>{entry.path}</span>
      <button class="close" onclick={closeViewer} aria-label="Close the viewer">Esc</button>
    </div>
  {/if}
  {#if target?.note}
    <p class="note" data-testid="viewer-note">{target.note}</p>
  {/if}
  {#if files.media !== null}
    <MediaStack item={files.media} />
  {:else if entry === null}
    <p class="empty">Pick a file to read it.</p>
  {:else if entry.binary}
    <p class="empty">Binary file, not shown.</p>
  {:else if view === "diff" && diff !== null && diff.lines.length > 0}
    <table class="lines diff">
      <tbody>
        {#each diff!.lines as line, i (i)}
          <tr
            class={line.kind}
            class:target={marked(line.new)}
            class:picked={inPick(line.new)}
            data-line={line.new ?? undefined}
          >
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
          <tr class:target={marked(i + 1)} class:picked={inPick(i + 1)} data-line={i + 1}>
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

  /* The lines the user selected, kept marked after the selection itself
     has gone with the keyboard. */
  tr.picked td {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .note {
    margin: 0;
    padding: 8px 12px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--rule);
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
    -webkit-user-select: none;
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

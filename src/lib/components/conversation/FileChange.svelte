<script lang="ts">
  import type { IntegratedFileChange } from "$lib/core";
  import { shortPath } from "$lib/thread";

  /** One file a tool call changed, as a diff: its hunks, or the whole of a
      new file as added lines. The changes pane is where the change is
      reviewed; this says what the call did. */
  interface Props {
    change: IntegratedFileChange;
    root: string | null;
  }

  let { change, root }: Props = $props();

  type Line = { kind: "add" | "del" | "ctx" | "hunk"; text: string };

  let lines = $derived.by((): Line[] => {
    if (change.kind === "create" && change.content !== null)
      return change.content
        .replace(/\n$/, "")
        .split("\n")
        .map((text) => ({ kind: "add", text }));
    const out: Line[] = [];
    for (const hunk of change.hunks) {
      out.push({
        kind: "hunk",
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      });
      for (const line of hunk.lines) {
        const mark = line.charAt(0);
        out.push({
          kind: mark === "+" ? "add" : mark === "-" ? "del" : "ctx",
          text: line.slice(1),
        });
      }
    }
    return out;
  });

  let added = $derived(lines.filter((line) => line.kind === "add").length);
  let removed = $derived(lines.filter((line) => line.kind === "del").length);

  const VERB = { create: "Created", update: "Changed", delete: "Deleted", move: "Moved" };
</script>

<div class="change" data-testid="file-change">
  <div class="head">
    <span class="verb">{VERB[change.kind]}</span>
    <span class="path" title={change.path}>{shortPath(change.path, root)}</span>
    {#if change.to !== null}
      <span class="verb">to</span>
      <span class="path" title={change.to}>{shortPath(change.to, root)}</span>
    {/if}
    <span class="count">
      {#if added > 0}<span class="add">+{added}</span>{/if}
      {#if removed > 0}<span class="del">−{removed}</span>{/if}
    </span>
  </div>
  {#if lines.length > 0}
    <div class="lines" data-testid="diff">
      {#each lines as line, at (at)}
        <div class="line {line.kind}"><span class="mark"
            >{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span
          >{line.text}</div>
      {/each}
    </div>
  {/if}
  {#if change.truncated}
    <p class="cut">The rest of this change was cut short on its way to the window.</p>
  {/if}
</div>

<style>
  .change {
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--surface);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 5px 10px;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    min-width: 0;
  }

  .verb {
    flex: none;
    color: var(--ink-2);
  }

  .path {
    font-family: var(--mono);
    font-size: var(--conv-fine);
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .count {
    margin-left: auto;
    flex: none;
    display: flex;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }

  .lines {
    border-top: 1px solid var(--rule);
    padding: 4px 0;
    max-height: 320px;
    overflow: auto;
    font: var(--conv-fine)/1.55 var(--mono);
    user-select: text;
    -webkit-user-select: text;
  }

  .line {
    padding: 0 10px 0 0;
    white-space: pre;
    color: var(--ink);
  }

  .mark {
    display: inline-block;
    width: 22px;
    text-align: center;
    color: var(--ink-3);
    user-select: none;
    -webkit-user-select: none;
  }

  .line.add {
    background: color-mix(in srgb, var(--add) 14%, transparent);
  }

  .line.add .mark {
    color: var(--add);
  }

  .line.del {
    background: color-mix(in srgb, var(--del) 14%, transparent);
  }

  .line.del .mark {
    color: var(--del);
  }

  .line.hunk {
    color: var(--ink-2);
    padding-left: 22px;
  }

  .cut {
    margin: 0;
    padding: 4px 10px 6px;
    font-size: var(--conv-fine);
    color: var(--ink-2);
  }
</style>

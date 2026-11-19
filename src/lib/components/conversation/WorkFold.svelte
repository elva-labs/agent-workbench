<script lang="ts">
  import type { TextPart, ToolCall } from "$lib/conversation.svelte";
  import { openFolds, toggle } from "$lib/folds";
  import { foldKey, workSummary } from "$lib/thread";
  import Icon from "./Icon.svelte";
  import Step from "./Step.svelte";

  /**
   * What the agent did between two things it said, folded into one line:
   * how long it worked and what came of it. Opened, the steps one per row.
   * The line counts the time while the work goes on.
   */
  interface Props {
    parts: (ToolCall | TextPart)[];
    root: string | null;
  }

  let { parts, root }: Props = $props();

  const folds = openFolds();
  let fold = $derived(foldKey("work", parts[0]));
  let open = $derived(folds().has(fold));
  let now = $state(Date.now());

  let summary = $derived(workSummary(parts, now));

  $effect(() => {
    if (!summary.running) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="fold" class:open data-testid="work">
  <button class="line" tabindex="-1" data-thread-item onclick={() => toggle(folds(), fold)} aria-expanded={open} data-testid="work-line">
    <span class="chev"><Icon name="chev" size={12} /></span>
    <span class="head" class:running={summary.running}>{summary.head}{summary.detail ? "," : ""}</span>
    {#if summary.detail}<span class="detail">{summary.detail}</span>{/if}
  </button>
  {#if open}
    <div class="steps" data-testid="work-steps">
      {#each parts as part (part.kind === "tool" ? part.call : part.block)}
        <Step {part} {root} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .fold {
    min-width: 0;
  }

  .line {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: min(100%, var(--conv-measure));
    padding: 2px 6px 2px 2px;
    margin-left: -2px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    color: var(--ink-2);
    cursor: pointer;
    text-align: left;
    min-width: 0;
  }

  .line > * {
    font-size: var(--conv-small);
  }

  .line:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .chev {
    flex: none;
    color: var(--ink-3);
    transition: transform 0.15s;
  }

  .open > .line .chev {
    transform: rotate(90deg);
  }

  .head {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .head.running {
    color: var(--accent);
  }

  .detail {
    min-width: 0;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 4px 0 2px 8px;
    padding-left: 10px;
    border-left: 1px solid var(--rule);
  }

  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>

<script lang="ts">
  import type { TextPart, ToolCall } from "$lib/conversation.svelte";
  import { answered, glyph, span, stepTitle } from "$lib/thread";
  import FileChange from "./FileChange.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import Parts from "./Parts.svelte";

  /**
   * One step of the agent's work: a tool call, or a stretch of thinking.
   * The row says what it did to what, and how it went; opened, it shows
   * the input, the output as it came, the files it changed, and for a
   * subagent what that subagent said and did.
   */
  interface Props {
    part: ToolCall | TextPart;
    root: string | null;
  }

  let { part, root }: Props = $props();

  let open = $state(false);

  let title = $derived(
    part.kind === "tool"
      ? stepTitle(part, root)
      : { verb: part.done ? "Thought" : "Thinking", object: null },
  );

  let status = $derived.by((): { text: string; tone: "run" | "bad" | "quiet" } | null => {
    if (part.kind !== "tool") return null;
    if (part.answer !== null && part.answer.choice !== "allow")
      return {
        text: answered(part.answer.choice),
        tone: part.answer.choice === "deny" || part.answer.choice === "cancel" ? "bad" : "quiet",
      };
    if (!part.done) return { text: "running", tone: "run" };
    if (part.error) return { text: "failed", tone: "bad" };
    const took = part.until - part.at;
    return took >= 1000 ? { text: span(took), tone: "quiet" } : null;
  });

  /** The input as the user reads it: a command as typed, the rest as the
      agent gave it. */
  let input = $derived.by((): { command: string } | { json: string } | null => {
    if (part.kind !== "tool") return null;
    const value = part.inputDone ? part.input : null;
    if (value === null || value === undefined) return part.inputText ? { json: part.inputText } : null;
    if (part.tool === "command" && typeof value === "object") {
      const command = (value as Record<string, unknown>).command;
      if (typeof command === "string") return { command };
    }
    return { json: JSON.stringify(value, null, 2) };
  });

  let output = $derived(
    part.kind === "tool" ? (part.done ? (part.result ?? part.output) : part.output) : "",
  );
  let tasks = $derived(part.kind === "tool" ? part.tasks.filter((task) => !task.ambient) : []);
</script>

<div class="step" class:open data-testid="step" data-tool={part.kind === "tool" ? part.tool : "thinking"}>
  <button
    class="row"
    onclick={() => (open = !open)}
    aria-expanded={open}
    data-testid="step-row"
  >
    <span class="glyph"><Icon name={glyph(part.kind === "tool" ? part.tool : "thinking")} size={13} /></span>
    <span class="title">
      <span class="verb">{title.verb}</span>
      {#if title.object !== null}<code class="object">{title.object}</code>{/if}
    </span>
    {#if status !== null}
      <span class="status {status.tone}" data-testid="step-status">{status.text}</span>
    {/if}
    <span class="chev"><Icon name="chev" size={12} /></span>
  </button>

  {#if open}
    <div class="detail" data-testid="step-detail">
      {#if part.kind !== "tool"}
        <div class="thinking"><Markdown text={part.text} /></div>
      {:else}
        {#if part.tool === "agent"}
          {#if tasks.length > 0}
            <ul class="tasks">
              {#each tasks as task (task.task)}
                <li class={task.status}>
                  <span class="dot"></span>{task.description ?? "Task"}
                  <span class="task-state"
                    >{task.status === "running" ? (task.tool ? `using ${task.tool}` : "running") : task.status}</span
                  >
                </li>
              {/each}
            </ul>
          {/if}
          {#if part.parts.length > 0}
            <div class="nested" data-testid="subagent"><Parts parts={part.parts} {root} nested /></div>
          {/if}
        {:else}
          {#if input !== null}
            {#if "command" in input}
              <!-- The row shows a short command whole; a long one is here. -->
              {#if input.command.includes("\n") || input.command.length > 72}
                <pre class="block command"><span class="prompt">$ </span>{input.command}</pre>
              {/if}
            {:else if part.tool !== "edit" || part.changes.length === 0}
              <pre class="block input">{input.json}</pre>
            {/if}
          {/if}
          {#each part.changes as change (change.path)}
            <FileChange {change} {root} />
          {/each}
          {#if tasks.length > 0}
            <ul class="tasks">
              {#each tasks as task (task.task)}
                <li class={task.status}>
                  <span class="dot"></span>{task.description ?? "Background task"}
                  <span class="task-state">{task.status === "running" ? "in the background" : task.status}</span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
        {#if output !== "" && part.tool !== "edit"}
          <pre class="block output" class:bad={part.error} data-testid="step-output">{output}</pre>
        {/if}
        {#if part.truncated || part.inputTruncated}
          <p class="cut">Some of this was cut short on its way to the window.</p>
        {:else if part.gap}
          <p class="cut">Some of the output did not reach the window; the result will hold all of it.</p>
        {/if}
        {#if part.answer?.message}
          <p class="said">You told the agent: {part.answer.message}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .step {
    min-width: 0;
  }

  .row {
    width: calc(100% + 12px);
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 6px;
    margin: 0 -6px;
    box-sizing: border-box;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }

  .row:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .glyph {
    color: var(--ink-3);
  }

  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
  }

  .verb {
    flex: none;
  }

  .object {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
  }

  .status {
    flex: none;
    font-size: 11.5px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .status.run {
    color: var(--accent);
  }

  .status.bad {
    color: var(--del);
  }

  .chev {
    flex: none;
    color: var(--ink-3);
    transition: transform 0.15s;
  }

  .open > .row .chev {
    transform: rotate(90deg);
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 0 8px 20px;
    min-width: 0;
  }

  .block {
    margin: 0;
    padding: 7px 10px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface-2);
    font: 11.5px/1.5 var(--mono);
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 280px;
    overflow: auto;
    user-select: text;
    -webkit-user-select: text;
  }

  .prompt {
    color: var(--ink-3);
    user-select: none;
    -webkit-user-select: none;
  }

  .output {
    background: var(--surface);
    color: var(--ink-2);
  }

  .output.bad {
    color: var(--del);
  }

  .thinking {
    color: var(--ink-2);
    font-size: 12.5px;
  }

  .nested {
    padding-left: 12px;
    border-left: 1px solid var(--rule-strong);
  }

  .tasks {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--ink-2);
  }

  .tasks li {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .tasks .dot {
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    background: var(--ink-3);
    flex: none;
  }

  .tasks .running .dot {
    background: var(--add);
    animation: breathe 1.6s ease-in-out infinite;
  }

  .tasks .failed .dot,
  .tasks .lost .dot {
    background: var(--del);
  }

  .task-state {
    margin-left: auto;
    color: var(--ink-3);
  }

  .cut,
  .said {
    margin: 0;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  @keyframes breathe {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tasks .running .dot {
      animation: none;
    }

    .chev {
      transition: none;
    }
  }
</style>

<script lang="ts">
  import type { TextPart, ToolCall } from "$lib/conversation.svelte";
  import { answered, glyph, inputPath, span, stepTitle } from "$lib/thread";
  import Copy from "./Copy.svelte";
  import FileChange from "./FileChange.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import Parts from "./Parts.svelte";
  import Plain from "./Plain.svelte";

  /**
   * One step of the agent's work: a tool call, or a stretch of thinking.
   * The row says what it did to what, and how it went; opened, it shows
   * the input, the output as it came, the files it changed, and for a
   * subagent what that subagent said and did. A command has a Copy beside
   * its row and another on its output.
   */
  interface Props {
    part: ToolCall | TextPart;
    root: string | null;
  }

  let { part, root }: Props = $props();

  let open = $state(false);
  const id = $props.id();

  let title = $derived(
    part.kind === "tool"
      ? stepTitle(part, root)
      : { lead: [part.done ? "Thought" : "Thinking"], object: null },
  );

  let status = $derived.by((): { text: string; tone: "run" | "bad" | "quiet" } | null => {
    if (part.kind !== "tool") return null;
    if (part.answer !== null && part.answer.choice !== "allow")
      return {
        text: answered(part.answer.choice),
        tone: part.answer.choice === "deny" || part.answer.choice === "cancel" ? "bad" : "quiet",
      };
    if (part.withdrawn && part.answer === null) return { text: "permission withdrawn", tone: "quiet" };
    if (!part.done) return { text: "running", tone: "run" };
    if (part.error) return { text: "failed", tone: "bad" };
    const took = part.until - part.at;
    return took >= 1000 ? { text: span(took), tone: "quiet" } : null;
  });

  /** The input as the user reads it: a command as typed, the rest as its
      fields, each named, leaving out what the row already says. Nothing
      when the row says all of it; while it streams, as it comes. */
  let input = $derived.by(
    (): { command: string } | { fields: { name: string; value: string }[] } | { json: string } | null => {
      if (part.kind !== "tool") return null;
      const value = part.inputDone ? part.input : null;
      if (value === null || value === undefined) return part.inputText ? { json: part.inputText } : null;
      if (typeof value !== "object" || Array.isArray(value)) return { json: JSON.stringify(value, null, 2) };
      const record = value as Record<string, unknown>;
      if (part.tool === "command" && typeof record.command === "string") return { command: record.command };
      const said = new Set([inputPath(value), title.object].filter((known) => known !== null));
      const fields = Object.entries(record)
        .filter(([, field]) => field !== null && field !== undefined && field !== "" && !said.has(field as string))
        .map(([name, field]) => ({
          name: name.replace(/_/g, " "),
          value: typeof field === "string" ? field : JSON.stringify(field, null, 2),
        }));
      return fields.length === 0 ? null : { fields };
    },
  );

  /** The command a step ran, as typed, once its input is whole. */
  let command = $derived(input !== null && "command" in input ? input.command : null);

  let output = $derived(
    part.kind === "tool" ? (part.done ? (part.result ?? part.output) : part.output) : "",
  );
  let tasks = $derived(part.kind === "tool" ? part.tasks.filter((task) => !task.ambient) : []);
</script>

<div class="step" class:open data-testid="step" data-tool={part.kind === "tool" ? part.tool : "thinking"}>
  <!-- The row's button reaches over the whole line, its status too, so a
       click anywhere on it folds, but on the Copy, which stands above. -->
  <div class="head" data-copy-host="command">
    <button
      class="row"
      tabindex="-1"
      data-thread-item
      onclick={() => (open = !open)}
      aria-expanded={open}
      aria-describedby={status !== null ? `${id}-status` : undefined}
      data-testid="step-row"
    >
      <span class="chev"><Icon name="chev" size={12} /></span>
      <span class="glyph"><Icon name={glyph(part.kind === "tool" ? part.tool : "thinking")} size={13} /></span>
      <span class="title">
        <span class="verb"
          >{#each title.lead as piece, at (at)}{#if typeof piece === "string"}{piece}{:else}<Plain text={piece.name} />{/if}{/each}</span
        >
        {#if title.object !== null}<code class="object"><Plain text={title.object} /></code>{/if}
        {#if part.kind === "tool" && part.inputTruncated}<span class="cut-mark" data-testid="step-cut">cut short</span>{/if}
      </span>
    </button>
    {#if command !== null}
      <Copy label="Copy command" text={() => command ?? ""} host="command" testid="copy-command" />
    {/if}
    {#if status !== null}
      <span class="status {status.tone}" id="{id}-status" data-testid="step-status">{status.text}</span>
    {/if}
  </div>

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
                  <span class="dot"></span>{#if task.description}<Plain text={task.description} />{:else}Task{/if}
                  <span class="task-state"
                    >{#if task.status === "running"}{#if task.tool}using <Plain text={task.tool} />{:else}running{/if}{:else}{task.status}{/if}</span
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
                <pre class="block command"><span class="prompt">$ </span><Plain text={input.command} /></pre>
              {/if}
            {:else if "fields" in input}
              {#if part.tool !== "edit" || part.changes.length === 0}
                <dl class="block fields" data-testid="step-input">
                  {#each input.fields as field (field.name)}
                    <dt><Plain text={field.name} /></dt>
                    <dd><Plain text={field.value} /></dd>
                  {/each}
                </dl>
              {/if}
            {:else}
              <pre class="block input"><Plain text={input.json} /></pre>
            {/if}
          {/if}
          {#each part.changes as change (change.path)}
            <FileChange {change} {root} />
          {/each}
          {#if tasks.length > 0}
            <ul class="tasks">
              {#each tasks as task (task.task)}
                <li class={task.status}>
                  <span class="dot"></span>{#if task.description}<Plain text={task.description} />{:else}Background task{/if}
                  <span class="task-state">{task.status === "running" ? "in the background" : task.status}</span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
        {#if output !== "" && part.tool !== "edit"}
          <div class="copyable" data-copy-host="output">
            <pre class="block output" class:bad={part.error} data-testid="step-output"><Plain text={output} /></pre>
            <Copy label="Copy output" text={() => output} host="output" place="corner" testid="copy-output" />
          </div>
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

  .head {
    position: relative;
    width: calc(100% + 12px);
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 6px;
    margin: 0 -6px;
    box-sizing: border-box;
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    font-size: var(--conv-small);
    min-width: 0;
  }

  .head:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: var(--radius-sm);
  }

  .row:focus-visible {
    outline: none;
  }

  .row:focus-visible::after {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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

  /* What the row shows was cut on its way to the window. */
  .cut-mark {
    flex: none;
    color: var(--del);
    font-size: var(--conv-fine);
  }

  .object,
  .command {
    unicode-bidi: isolate;
    direction: ltr;
  }

  .object {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
    font-size: var(--conv-fine);
    color: var(--ink);
  }

  .status {
    flex: none;
    font-size: var(--conv-fine);
    color: var(--ink-2);
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

  .open > .head .chev {
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
    font: var(--conv-fine)/1.5 var(--mono);
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 280px;
    overflow: auto;
    user-select: text;
    -webkit-user-select: text;
  }

  .fields {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 2px 12px;
  }

  .fields dt {
    color: var(--ink-2);
  }

  .fields dd {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .prompt {
    color: var(--ink-3);
    user-select: none;
    -webkit-user-select: none;
  }

  .copyable {
    position: relative;
    min-width: 0;
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
    font-size: var(--conv-small);
  }

  .nested {
    padding-left: 12px;
    border-left: 1px solid var(--rule-strong);
  }

  .tasks {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--conv-meta);
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
    color: var(--ink-2);
  }

  .cut,
  .said {
    margin: 0;
    font-size: var(--conv-fine);
    color: var(--ink-2);
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

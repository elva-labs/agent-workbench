<script lang="ts">
  import Plain from "./Plain.svelte";
  import type { Part } from "$lib/conversation.svelte";
  import { segments } from "$lib/thread";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import WorkFold from "./WorkFold.svelte";

  /**
   * What the agent said and did, in order: its text as written, its plan
   * and the questions it asked in sight, and each stretch of work between
   * them folded into one line. A subagent's own run is drawn the same way
   * under the step that started it. The last thinking before the
   * workbench's own calls is in sight, marked as its thinking.
   */
  interface Props {
    parts: Part[];
    root: string | null;
    nested?: boolean;
    /** Runs a command the agent wrote in its text for the user to run.
        Its thinking and its plan, and a subagent's text, get no Run. */
    onrun?: (command: string) => void;
  }

  let { parts, root, nested = false, onrun }: Props = $props();

  let drawn = $derived(segments(parts));

  const STEP = { done: "check", active: "chev", pending: "" } as const;
</script>

<div class="parts" class:nested>
  {#each drawn as segment (segment.kind === "work" ? segment.key : segment.kind === "text" || segment.kind === "thought" ? segment.part.block : segment.kind === "question" ? segment.part.request : `plan-${segment.part.at}`)}
    {#if segment.kind === "text"}
      <div class="text" data-testid="agent-text" data-find={segment.part.block}>
        <Markdown text={segment.part.text} streaming={!segment.part.done} onrun={nested ? undefined : onrun} />
        {#if segment.part.gap && segment.part.done}
          <p class="gap" data-find-skip>Some of this did not reach the window.</p>
        {/if}
      </div>
    {:else if segment.kind === "thought"}
      <div class="thought" data-testid="agent-thought" data-find={segment.part.block}>
        <p class="thought-head" data-find-skip><Icon name="thought" size={13} />Summary of the agent's thinking</p>
        <Markdown text={segment.part.text} />
      </div>
    {:else if segment.kind === "work"}
      <WorkFold parts={segment.parts} {root} />
    {:else if segment.kind === "plan"}
      <div class="plan" data-testid="plan" data-find="plan-{segment.part.at}">
        <div class="plan-head" data-find-skip><Icon name="plan" size={13} />Plan</div>
        {#if segment.part.steps.length > 0}
          <ol class="plan-steps">
            {#each segment.part.steps as step, at (at)}
              <li class={step.status}>
                <span class="mark" data-find-skip>{#if STEP[step.status]}<Icon name={STEP[step.status]} size={12} />{/if}</span>
                <span><Plain text={step.text} /></span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if segment.part.text}
          <div class="plan-text"><Markdown text={segment.part.text} /></div>
        {/if}
      </div>
    {:else if segment.kind === "question"}
      {@const part = segment.part}
      <div class="asked" data-testid="asked" data-find={part.request}>
        {#each part.questions as question, at (at)}
          <p class="question"><span class="label" data-find-skip>Asked</span><Plain text={question.question} /></p>
          {#if part.outcome === "answered"}
            {@const answer = part.answers?.[at] ?? null}
            <p class="answer">
              <span class="label" data-find-skip>You</span>{#if answer === null}<span class="quiet" data-find-skip
                  >answered. The answer is not shown.</span
                >{:else}<Plain text={answer.join(", ")} />{/if}
            </p>
          {/if}
        {/each}
        {#if part.outcome === "declined"}
          <p class="answer quiet" data-find-skip>You chose not to answer.</p>
        {:else if part.outcome === "withdrawn"}
          <p class="answer quiet" data-find-skip>The agent stopped waiting for an answer.</p>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .parts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .parts.nested {
    gap: 6px;
    font-size: var(--conv-small);
  }

  .text {
    min-width: 0;
  }

  /* Words that follow words of another part keep the room a paragraph or a
     heading has after a block inside one part: the part's own first margin
     is zero, so the room comes from here, short of the gap between parts. */
  .text + .text {
    margin-top: max(0px, calc(0.7em - 8px));
  }

  .text + .text:has(> :global(.md) > :global(:is(h1, h2, h3, h4):first-child)) {
    margin-top: max(0px, calc(1em - 8px));
  }

  .thought {
    min-width: 0;
    max-width: var(--conv-measure);
    padding-left: 11px;
    border-left: 2px solid var(--rule-strong);
  }

  .thought-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 4px;
    font-family: var(--chrome);
    font-size: var(--conv-meta);
    font-weight: 600;
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .gap {
    margin: 4px 0 0;
    font-size: var(--conv-fine);
    color: var(--ink-2);
  }

  .plan {
    max-width: var(--conv-measure);
    border: 1px solid var(--divider, var(--rule));
    border-radius: calc(var(--radius) + 3px);
    padding: 8px 12px 9px;
    background: var(--clear-surface);
  }

  .plan-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    font-family: var(--chrome);
    font-size: var(--conv-meta);
    font-weight: 600;
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .plan-steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--conv-small);
  }

  .plan-steps li {
    display: flex;
    align-items: baseline;
    gap: 7px;
  }

  .plan-steps .mark {
    flex: none;
    width: 12px;
    height: 12px;
    align-self: center;
    display: grid;
    place-items: center;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
  }

  .plan-steps .done {
    color: var(--ink-2);
  }

  .plan-steps .done .mark {
    box-shadow: none;
    color: var(--add);
  }

  .plan-steps .active {
    color: var(--ink);
    font-weight: 500;
  }

  .plan-steps .active .mark {
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--accent);
  }

  .plan-text {
    font-size: var(--conv-small);
  }

  .asked {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    border-radius: var(--radius);
    background: var(--surface-2);
    max-width: var(--conv-measure);
  }

  .asked p {
    margin: 0;
    font-size: var(--conv-small);
  }

  .label {
    display: inline-block;
    min-width: 48px;
    margin-right: 6px;
    font-family: var(--chrome);
    font-size: var(--conv-fine);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .answer {
    color: var(--ink);
  }

  .quiet {
    color: var(--ink-2);
  }
</style>

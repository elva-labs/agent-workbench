<script lang="ts">
  /**
   * A workflow drawn as a diagram. The orchestrator is the session the user
   * talks to, so it is the frame, with its model on it; the steps sit inside
   * it in order with an arrow between each and a plus on each arrow to add a
   * step. A review that goes back draws a line under the row from itself to
   * the step it repeats, with its limit written beneath.
   */
  import type { Workflow, WorkflowModel, WorkflowStep } from "$lib/core";
  import { installed } from "$lib/agent.svelte";
  import {
    AGENT_LABELS,
    modelFromKey,
    modelKey,
    modelLabel,
    modelsOf,
    offeredAgents,
  } from "$lib/models";

  interface Props {
    workflow: Workflow;
    selected: number;
    onSelect: (index: number) => void;
    onAdd: (at: number, kind: WorkflowStep["kind"]) => void;
    onOrchestrator: (model: WorkflowModel) => void;
  }

  let { workflow, selected, onSelect, onAdd, onOrchestrator }: Props = $props();

  /** The arrow whose plus is open, by the index a new step would take. */
  let adding = $state<number | null>(null);

  /** Widths the geometry of the lines under the row depends on. */
  const NODE = 140;
  const ARROW = 44;
  const STRIDE = NODE + ARROW;
  /** Room a loop's line takes beneath the row, and each deeper one adds. */
  const DEPTH = 22;
  const FIRST = 14;

  const centre = (index: number) => index * STRIDE + NODE / 2;

  interface Loop {
    from: number;
    to: number;
    level: number;
    text: string;
  }

  /** The line each review draws, a level down from any it overlaps. */
  const loops = $derived.by(() => {
    const out: Loop[] = [];
    workflow.steps.forEach((step, index) => {
      if (step.kind !== "review") return;
      const to = workflow.steps.findIndex((other) => other.name === step.backTo);
      if (to < 0 || to >= index) return;
      let level = 0;
      while (out.some((other) => other.level === level && other.to < index && to < other.from)) {
        level += 1;
      }
      const rounds = step.limit === 1 ? "1 round" : `${step.limit} rounds`;
      out.push({
        from: index,
        to,
        level,
        text: `Back to ${step.backTo} until approved, ${rounds} at most`,
      });
    });
    return out;
  });

  const levels = $derived(loops.reduce((most, loop) => Math.max(most, loop.level + 1), 0));

  const agents = $derived(
    offeredAgents(installed(), [
      workflow.orchestrator.agent,
      ...workflow.steps.flatMap((step) => step.models.map((model) => model.agent)),
    ]),
  );

  const orchestratorKey = $derived(modelKey(workflow.orchestrator));

  function pick(event: Event) {
    const model = modelFromKey((event.currentTarget as HTMLSelectElement).value);
    if (model !== null) onOrchestrator(model);
  }

  function add(at: number, kind: WorkflowStep["kind"]) {
    adding = null;
    onAdd(at, kind);
  }

  function popoverKeys(event: KeyboardEvent) {
    if (event.key !== "Escape" || adding === null) return;
    // Escape closes the choice and nothing more; the settings stay open.
    event.preventDefault();
    event.stopPropagation();
    const returnTo = adding;
    adding = null;
    document
      .querySelector<HTMLElement>(`[data-testid="workflow-add"][data-at="${returnTo}"]`)
      ?.focus();
  }

  /** The first choice takes the keyboard when the plus opens them. */
  function focusFirst(node: HTMLElement) {
    node.querySelector("button")?.focus();
  }

  const ROLE = { work: "Does the task", review: "Checks the work" } as const;

  function shown(step: WorkflowStep): string[] {
    return step.models.map((model) => modelLabel(model.agent, model.model));
  }
</script>

<div class="canvas" data-testid="workflow-canvas">
  <div class="orch" data-testid="workflow-orchestrator">
    <div class="orch-head">
      <b>Orchestrator</b>
      <span class="note">The session you talk to. It runs the steps below.</span>
      <label class="pill">
        <span class="sr">Orchestrator model</span>
        <select value={orchestratorKey} onchange={pick} data-testid="workflow-orchestrator-model">
          {#each agents as agent (agent)}
            <optgroup label={AGENT_LABELS[agent]}>
              {#each modelsOf(agent) as option (option.model)}
                <option value={modelKey(option)}>{option.label}</option>
              {/each}
              {#if workflow.orchestrator.agent === agent && !modelsOf(agent).some((option) => option.model === workflow.orchestrator.model)}
                <option value={orchestratorKey}>{workflow.orchestrator.model}</option>
              {/if}
            </optgroup>
          {/each}
        </select>
        <span class="chev" aria-hidden="true">▾</span>
      </label>
    </div>

    <div class="flow">
      <div class="flow-row" data-testid="workflow-steps">
        {#each workflow.steps as step, index (step.name)}
          <button
            type="button"
            class="node"
            class:sel={selected === index}
            aria-pressed={selected === index}
            onclick={() => onSelect(index)}
            data-testid="workflow-step"
            data-step={step.name}
            data-kind={step.kind}
          >
            <b>{step.name}</b>
            <span class="role">{ROLE[step.kind]}</span>
            <span class="models">
              {#if step.models.length === 0}
                <span>Any model</span>
              {:else}
                {#each shown(step) as label, at (at)}<span>{label}</span>{/each}
              {/if}
            </span>
          </button>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="arrow" onkeydown={popoverKeys}>
            <button
              type="button"
              class="ins"
              aria-label="Add a step after {step.name}"
              aria-expanded={adding === index + 1}
              onclick={() => (adding = adding === index + 1 ? null : index + 1)}
              data-testid="workflow-add"
              data-at={index + 1}
            >
              +
            </button>
            {#if adding === index + 1}
              <div class="choose" use:focusFirst data-testid="workflow-add-choice">
                <button type="button" onclick={() => add(index + 1, "work")} data-testid="workflow-add-work">Work</button>
                <button
                  type="button"
                  onclick={() => add(index + 1, "review")}
                  data-testid="workflow-add-review">Review</button
                >
              </div>
            {/if}
          </div>
        {/each}
        <div class="end">Reports to you</div>
      </div>

      {#if loops.length > 0}
        <div class="loops" style:height="{FIRST + (levels - 1) * DEPTH + 28}px">
          {#each loops as loop (loop.from)}
            {@const depth = FIRST + loop.level * DEPTH}
            <div
              class="loop"
              style:left="{centre(loop.to)}px"
              style:width="{centre(loop.from) - centre(loop.to)}px"
              style:height="{depth}px"
              data-testid="workflow-loop"
              data-from={workflow.steps[loop.from].name}
              data-to={workflow.steps[loop.to].name}
            ></div>
            <div
              class="loop-label"
              style:left="{(centre(loop.to) + centre(loop.from)) / 2}px"
              style:top="{depth + 4}px"
              data-testid="workflow-loop-label"
            >
              {loop.text}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .canvas {
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: 12px;
    overflow-x: auto;
  }

  .orch {
    width: max-content;
    min-width: 100%;
    box-sizing: border-box;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    background: var(--surface);
  }

  .orch-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--rule);
  }

  .orch-head b {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--heading-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink);
  }

  .note {
    flex: 1;
    min-width: 150px;
    font-size: 12px;
    color: var(--ink-3);
  }

  .pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 24px;
    border-radius: var(--radius-tag);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink-2);
  }

  .pill select {
    appearance: none;
    height: 100%;
    padding: 0 22px 0 9px;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: 12px;
    color: inherit;
    cursor: pointer;
  }

  .pill:focus-within {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .chev {
    position: absolute;
    right: 8px;
    pointer-events: none;
    font-size: 10px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .flow {
    position: relative;
    width: max-content;
    padding: 18px 16px 14px;
  }

  .flow-row {
    display: flex;
    align-items: stretch;
  }

  .node {
    flex: none;
    box-sizing: border-box;
    width: 140px;
    padding: 8px 11px 9px;
    border: 0;
    border-radius: var(--radius);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    text-align: left;
    font: inherit;
    color: var(--ink);
    cursor: pointer;
  }

  .node b {
    display: block;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .role {
    display: block;
    margin-bottom: 7px;
    font-size: 11.5px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .models {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .models span {
    padding: 0 7px;
    border-radius: var(--radius-tag);
    background: var(--surface);
    font-size: 11.5px;
    line-height: 18px;
    color: var(--ink-2);
  }

  .node:hover {
    box-shadow: inset 0 0 0 1px var(--ink-3);
  }

  .node.sel {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }

  .node:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .arrow {
    position: relative;
    flex: none;
    align-self: center;
    width: 44px;
    height: 1px;
    background: var(--ink-3);
  }

  .arrow::after {
    content: "";
    position: absolute;
    right: -1px;
    top: -4px;
    border: 4px solid transparent;
    border-left: 6px solid var(--ink-3);
    border-right: 0;
  }

  .ins {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    transform: translate(-60%, -50%);
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font-size: 12px;
    line-height: 1;
    color: var(--ink-3);
    cursor: pointer;
  }

  .ins:hover,
  .ins:focus-visible,
  .ins[aria-expanded="true"] {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    outline: none;
  }

  .choose {
    position: absolute;
    left: 50%;
    top: 14px;
    z-index: 2;
    display: flex;
    transform: translateX(-50%);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 6px 18px color-mix(in srgb, black 25%, transparent);
    overflow: hidden;
  }

  .choose button {
    padding: 3px 9px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-2);
    cursor: pointer;
  }

  .choose button:last-child {
    border-right: 0;
  }

  .choose button:hover,
  .choose button:focus-visible {
    background: var(--accent-soft);
    color: var(--accent);
    outline: none;
  }

  .end {
    align-self: center;
    padding-left: 8px;
    font-size: 12px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .loops {
    position: relative;
  }

  .loop {
    position: absolute;
    top: 0;
    box-sizing: border-box;
    border: 1px solid var(--accent);
    border-top: 0;
    border-radius: 0 0 10px 10px;
  }

  .loop::before {
    content: "";
    position: absolute;
    left: -5px;
    top: -1px;
    border: 4.5px solid transparent;
    border-top: 0;
    border-bottom: 7px solid var(--accent);
  }

  .loop-label {
    position: absolute;
    transform: translateX(-50%);
    text-align: center;
    font-size: 11.5px;
    color: var(--accent);
    white-space: nowrap;
  }
</style>

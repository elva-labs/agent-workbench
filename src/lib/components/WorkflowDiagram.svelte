<script module lang="ts">
  /** The widths the diagram is laid out by. A step is as wide as the room
      allows, from the least to the most. */
  export const NODE = 140;
  export const LEAST_NODE = 100;
  export const ARROW = 32;
  /** Room for "Reports to you" after the last arrow, on two lines. */
  export const END = 60;
  /** The flow's padding inside the frame, and the canvas's around it, each side. */
  export const FLOW_PAD = 12;
  export const CANVAS_PAD = 8;

  /** The least width a diagram of so many steps is drawn in whole. */
  export function leastWidth(count: number): number {
    return 2 * CANVAS_PAD + 2 + 2 * FLOW_PAD + count * (LEAST_NODE + ARROW) + END;
  }
</script>

<script lang="ts">
  /**
   * A workflow drawn as a diagram. The orchestrator is the session the user
   * talks to, so it is the frame, with its model on it; the steps sit inside
   * it in order with an arrow between each and a plus on each arrow that
   * opens a menu to add a step there. The picked step has arrows above it
   * that move it earlier or later, as Alt with the arrow keys does. A review
   * that goes back draws a line under the row from itself to the step it
   * repeats, lines arriving at one step side by side, and under all the
   * lines each review's label says where it goes back to, until what, and
   * how often.
   *
   * The steps share the width there is, down to the least a step needs; past
   * that the row scrolls sideways under the orchestrator's head, which stays
   * put, with the edge that hides more faded.
   */
  import type { ReviewStep, Workflow, WorkflowModel, WorkflowStep } from "$lib/core";
  import { installed } from "$lib/agent.svelte";
  import { moveProblem } from "$lib/workflows.svelte";
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
    /** Moves a step; the keyboard then goes to the control named, or to
        the step itself when none is. */
    onMove: (from: number, to: number, focus: string | null) => void;
    onOrchestrator: (model: WorkflowModel) => void;
  }

  let { workflow, selected, onSelect, onAdd, onMove, onOrchestrator }: Props = $props();

  /** Why the picked step cannot move earlier or later, or null. */
  const earlierProblem = $derived(moveProblem(workflow, selected, selected - 1));
  const laterProblem = $derived(moveProblem(workflow, selected, selected + 1));

  /** Alt with an arrow moves the picked step, as its arrows do. */
  function nodeKeys(event: KeyboardEvent, index: number) {
    if (!event.altKey || index !== selected) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const by = event.key === "ArrowLeft" ? -1 : 1;
    if ((by < 0 ? earlierProblem : laterProblem) !== null) return;
    onMove(index, index + by, null);
  }

  function moveBy(by: number) {
    if ((by < 0 ? earlierProblem : laterProblem) !== null) return;
    onMove(selected, selected + by, by < 0 ? "step-move-earlier" : "step-move-later");
  }

  /** Room a loop's line takes beneath the row, and each deeper one adds. */
  const DEPTH = 14;
  const FIRST = 14;
  /** The height of a row of loop labels. */
  const LABEL_ROW = 18;

  let scroller = $state<HTMLDivElement | null>(null);
  /** The width the flow has before it scrolls. */
  let room = $state(0);
  let atStart = $state(true);
  let atEnd = $state(true);

  const count = $derived(workflow.steps.length);
  const node = $derived(
    room === 0
      ? NODE
      : Math.max(LEAST_NODE, Math.min(NODE, Math.floor((room - 2 * FLOW_PAD - count * ARROW - END) / count))),
  );
  const stride = $derived(node + ARROW);
  const rowWidth = $derived(count * stride + END);

  const centre = (index: number) => index * stride + node / 2;

  interface Loop {
    from: number;
    to: number;
    level: number;
    /** Where the line arrives: at the middle of the step it goes back to,
        and further left for each line arriving there above it, so lines
        arriving at one step never cross. */
    arrive: number;
    text: string;
  }

  /** How far apart lines arriving at one step stand. */
  const BESIDE = 10;

  /** Until when a review sends the work back, in its own terms. */
  function until(step: ReviewStep): string {
    if (step.reviewerApproves && step.orchestratorAgrees) return "until both approve";
    return step.reviewerApproves ? "until the reviewer approves" : "until the orchestrator agrees";
  }

  /** The line each review draws, a level down from any it overlaps. */
  const loops = $derived.by(() => {
    const out: Loop[] = [];
    workflow.steps.forEach((step, index) => {
      if (step.kind !== "review") return;
      const to = workflow.steps.findIndex((other) => other.name === step.backTo);
      if (to < 0 || to >= index) return;
      let level = 0;
      while (out.some((other) => other.level === level && other.to <= index && to <= other.from)) {
        level += 1;
      }
      const rounds = step.limit === 1 ? "1 round" : `${step.limit} rounds`;
      out.push({
        from: index,
        to,
        level,
        arrive: 0,
        text: `${step.name}: back to ${step.backTo} ${until(step)}, ${rounds} at most`,
      });
    });
    for (const loop of out) {
      const above = out.filter((other) => other.to === loop.to && other.level < loop.level).length;
      loop.arrive = above * BESIDE;
    }
    return out;
  });

  const levels = $derived(loops.reduce((most, loop) => Math.max(most, loop.level + 1), 0));
  const linesHeight = $derived(levels === 0 ? 0 : FIRST + (levels - 1) * DEPTH + 2);
  let labelWidths = $state<number[]>([]);

  /** Where a label sits: centred under its line, kept inside the row. */
  function labelLeft(loop: Loop, at: number): number {
    const width = labelWidths[at] ?? 0;
    const mid = (centre(loop.to) - loop.arrive + centre(loop.from)) / 2;
    return Math.max(0, Math.min(mid - width / 2, rowWidth - width));
  }

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

  /** Which edges of the row hide more of it. */
  function measure() {
    if (scroller === null) return;
    atStart = scroller.scrollLeft <= 1;
    atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
  }

  $effect(() => {
    void [room, rowWidth, linesHeight, ...labelWidths];
    measure();
  });

  /** The row's own size moves with its steps and lines as well. */
  $effect(() => {
    const flow = scroller?.firstElementChild;
    if (!flow) return;
    const watch = new ResizeObserver(measure);
    watch.observe(flow);
    return () => watch.disconnect();
  });

  /** The step picked is scrolled into the row's view, sideways only. */
  $effect(() => {
    if (scroller === null) return;
    const left = FLOW_PAD + selected * stride;
    const right = left + node;
    const view = scroller.clientWidth;
    if (left - FLOW_PAD < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - FLOW_PAD);
    else if (right + FLOW_PAD > scroller.scrollLeft + view) scroller.scrollLeft = right + FLOW_PAD - view;
    measure();
  });

  /** The arrow whose menu is open, by the index a new step would take, and
      where the menu stands on screen. */
  let adding = $state<number | null>(null);
  let menuAt = $state({ left: 0, top: 0 });
  let menu = $state<HTMLElement | null>(null);

  function plusOf(at: number): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="workflow-add"][data-at="${at}"]`);
  }

  function toggleMenu(at: number, event: MouseEvent) {
    if (adding === at) {
      adding = null;
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 188;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
    menuAt = { left, top: box.bottom + 6 };
    adding = at;
  }

  function close(returnFocus: boolean) {
    const at = adding;
    adding = null;
    if (returnFocus && at !== null) plusOf(at)?.focus();
  }

  function add(at: number, kind: WorkflowStep["kind"]) {
    adding = null;
    onAdd(at, kind);
  }

  /** The menu closes when the pointer goes down outside it, the panel
      scrolls or the window resizes, since it no longer stands by its plus. */
  $effect(() => {
    if (adding === null) return;
    const at = adding;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu?.contains(target) || plusOf(at)?.contains(target)) return;
      adding = null;
    };
    const away = (event: Event) => {
      if (menu?.contains(event.target as Node)) return;
      adding = null;
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  });

  function items(): HTMLElement[] {
    return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  }

  function menuKeys(event: KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      // Escape closes the menu and nothing more; the settings stay open.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const by = event.key === "ArrowDown" ? 1 : -1;
      all[(at + by + all.length) % all.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    }
  }

  function leaving(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next !== null && menu?.contains(next)) return;
    adding = null;
  }

  /** The first item takes the keyboard when the menu opens. */
  function focusFirst(node: HTMLElement) {
    node.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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
        <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </label>
    </div>

    <div class="row-box">
      <div
        class="scroller"
        bind:this={scroller}
        bind:clientWidth={room}
        onscroll={measure}
        data-testid="workflow-flow"
      >
        <div class="flow" style:padding="28px {FLOW_PAD}px 14px">
          <div class="flow-row" data-testid="workflow-steps">
            {#each workflow.steps as step, index (step.name)}
              <div class="cell" style:width="{node}px">
                {#if selected === index}
                  <div class="mover" role="group" aria-label="Move {step.name}">
                    <button
                      type="button"
                      aria-label="Move {step.name} earlier"
                      aria-disabled={earlierProblem !== null}
                      aria-describedby={earlierProblem === null ? undefined : "move-earlier-why"}
                      title={earlierProblem ?? "Move earlier (Alt+Left)"}
                      onclick={() => moveBy(-1)}
                      data-testid="step-move-earlier"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>
                    </button>
                    <button
                      type="button"
                      aria-label="Move {step.name} later"
                      aria-disabled={laterProblem !== null}
                      aria-describedby={laterProblem === null ? undefined : "move-later-why"}
                      title={laterProblem ?? "Move later (Alt+Right)"}
                      onclick={() => moveBy(1)}
                      data-testid="step-move-later"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                    </button>
                    {#if earlierProblem !== null}<span class="sr" id="move-earlier-why">{earlierProblem}</span>{/if}
                    {#if laterProblem !== null}<span class="sr" id="move-later-why">{laterProblem}</span>{/if}
                  </div>
                {/if}
                <button
                  type="button"
                  class="node"
                  class:sel={selected === index}
                  aria-pressed={selected === index}
                  aria-keyshortcuts={selected === index ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
                  onclick={() => onSelect(index)}
                  onkeydown={(event) => nodeKeys(event, index)}
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
              </div>
              <div class="arrow" style:width="{ARROW}px">
                <button
                  type="button"
                  class="ins"
                  aria-label="Add a step after {step.name}"
                  aria-haspopup="menu"
                  aria-expanded={adding === index + 1}
                  onclick={(event) => toggleMenu(index + 1, event)}
                  data-testid="workflow-add"
                  data-at={index + 1}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
                </button>
                {#if adding === index + 1}
                  <!-- svelte-ignore a11y_interactive_supports_focus -->
                  <div
                    class="menu"
                    role="menu"
                    aria-label="Add a step after {step.name}"
                    style:left="{menuAt.left}px"
                    style:top="{menuAt.top}px"
                    bind:this={menu}
                    use:focusFirst
                    onkeydown={menuKeys}
                    onfocusout={leaving}
                    data-testid="workflow-add-choice"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      tabindex="-1"
                      onclick={() => add(index + 1, "work")}
                      data-testid="workflow-add-work"
                    >
                      <span>Work step</span><small>Does the task</small>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabindex="-1"
                      onclick={() => add(index + 1, "review")}
                      data-testid="workflow-add-review"
                    >
                      <span>Review step</span><small>Checks the work</small>
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
            <div class="end" style:width="{END}px">Reports to you</div>
          </div>

          {#if loops.length > 0}
            <div class="loops" style:height="{linesHeight + 4 + loops.length * LABEL_ROW}px" style:width="{rowWidth}px">
              {#each loops as loop, at (loop.from)}
                <div
                  class="loop"
                  style:left="{centre(loop.to) - loop.arrive}px"
                  style:width="{centre(loop.from) - centre(loop.to) + loop.arrive}px"
                  style:height="{FIRST + loop.level * DEPTH}px"
                  data-testid="workflow-loop"
                  data-from={workflow.steps[loop.from].name}
                  data-to={workflow.steps[loop.to].name}
                ></div>
                <div
                  class="loop-label"
                  style:left="{labelLeft(loop, at)}px"
                  style:top="{linesHeight + 4 + at * LABEL_ROW}px"
                  bind:clientWidth={labelWidths[at]}
                  data-testid="workflow-loop-label"
                  data-from={workflow.steps[loop.from].name}
                >
                  {loop.text}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      {#if !atStart}<div class="fade fade-start" aria-hidden="true" data-testid="workflow-more-before"></div>{/if}
      {#if !atEnd}<div class="fade fade-end" aria-hidden="true" data-testid="workflow-more-after"></div>{/if}
    </div>
  </div>
</div>

<style>
  .canvas {
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: 8px;
  }

  .orch {
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

  .pill select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-tag);
  }

  .chev {
    position: absolute;
    right: 7px;
    width: 11px;
    height: 11px;
    pointer-events: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  /* The row scrolls sideways when the steps do not fit at their least,
     and the edge that hides more fades out. */
  .row-box {
    position: relative;
  }

  .scroller {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .fade {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 36px;
    pointer-events: none;
  }

  .fade-start {
    left: 0;
    border-bottom-left-radius: var(--radius);
    background: linear-gradient(to right, var(--surface), transparent);
  }

  .fade-end {
    right: 0;
    border-bottom-right-radius: var(--radius);
    background: linear-gradient(to left, var(--surface), transparent);
  }

  .flow {
    position: relative;
    width: max-content;
  }

  .flow-row {
    display: flex;
    align-items: stretch;
  }

  .cell {
    position: relative;
    flex: none;
    display: flex;
  }

  /* The picked step's arrows sit above it, out of its text's way. */
  .mover {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 4px);
    display: flex;
    gap: 2px;
    transform: translateX(-50%);
  }

  .mover button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-tag);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }

  .mover button:hover:not([aria-disabled="true"]) {
    background: var(--surface-2);
    color: var(--accent);
  }

  .mover button[aria-disabled="true"] {
    opacity: 0.35;
    cursor: default;
  }

  .mover button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .mover svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .node {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    box-sizing: border-box;
    min-width: 0;
    padding: 8px 9px 9px;
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
    line-height: 1.3;
    color: var(--ink-3);
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
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    transform: translate(-60%, -50%);
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink-3);
    cursor: pointer;
  }

  /* A larger target than the circle drawn. */
  .ins::before {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
  }

  .ins svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .ins:hover,
  .ins[aria-expanded="true"] {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .ins:focus-visible {
    color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .menu {
    position: fixed;
    z-index: 30;
    width: 188px;
    padding: 4px 0;
    box-sizing: border-box;
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 8px 24px color-mix(in srgb, black 25%, transparent);
  }

  .menu button {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 12px;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: 12.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .menu small {
    font-family: var(--sans);
    font-size: 11.5px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink-3);
  }

  .menu button:hover,
  .menu button:focus-visible,
  .menu button:focus {
    background: var(--accent-soft);
    outline: none;
  }

  .end {
    flex: none;
    box-sizing: border-box;
    align-self: center;
    padding-left: 8px;
    font-size: 12px;
    line-height: 1.3;
    color: var(--ink-3);
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
    font-size: 11.5px;
    line-height: 16px;
    color: var(--accent);
    white-space: nowrap;
  }
</style>

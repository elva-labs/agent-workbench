<script lang="ts">
  /**
   * The settings of the step picked in the diagram, top to bottom: its name,
   * whether it does work or reviews it, the models it may use, and the
   * settings of its kind. A work step says how many sessions may run at
   * once; a review says when the work passes and, as one sentence, where it
   * goes back to otherwise and how often before you are asked. Each change
   * applies at once; a control the rules would always refuse is dimmed and
   * says why, and a refusal that cannot be known before is said beside the
   * control it came from, for as long as that step is picked. Removing the
   * step, asked first, is at the foot.
   */
  import { tick } from "svelte";
  import type { Workflow, WorkflowModel } from "$lib/core";
  import { installed } from "$lib/agent.svelte";
  import { AGENT_LABELS, modelsOf, offeredAgents, sameModel } from "$lib/models";
  import {
    MOST_PARALLEL,
    MOST_ROUNDS,
    removeProblem,
    removeStep,
    setStepKind,
    updateStep,
    withoutStep,
    type StepPatch,
  } from "$lib/workflows.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";

  interface Props {
    workflow: Workflow;
    index: number;
    /** A step was moved or removed, so the one picked moves with it. */
    onMoved: (index: number) => void;
  }

  let { workflow, index, onMoved }: Props = $props();

  const step = $derived(workflow.steps[index]);
  /** The steps a review may send the work back to: the work before it. */
  const targets = $derived(workflow.steps.slice(0, index).filter((other) => other.kind === "work"));

  /** Which control a refusal came from. */
  type Where = "name" | "kind" | "models" | "parallel" | "passes" | "back" | "remove";

  /** The step a refusal or a question belongs to; either is shown only
      while that step is picked. */
  const here = $derived(`${workflow.name}\u0000${index}`);
  let refusal = $state<{ at: string; where: Where; text: string } | null>(null);
  const problem = (where: Where) =>
    refusal !== null && refusal.at === here && refusal.where === where ? refusal.text : null;

  let removing = $state<string | null>(null);
  const askingRemove = $derived(removing === here);

  /** Picking another step, or another workflow, leaves what was said and
      asked about the last one behind. */
  let shownFor: string | null = null;
  $effect.pre(() => {
    if (shownFor !== null && here !== shownFor) {
      refusal = null;
      removing = null;
    }
    shownFor = here;
  });

  let root = $state<HTMLElement | null>(null);

  const agents = $derived(
    offeredAgents(installed(), [
      ...workflow.steps.flatMap((other) => other.models.map((model) => model.agent)),
    ]),
  );

  /** What a group of checkboxes shows for an agent: the models it offers,
      then any the step already names that the list does not hold. */
  function optionsFor(agent: WorkflowModel["agent"]) {
    const known = modelsOf(agent);
    const extra = step.models
      .filter((model) => model.agent === agent && !known.some((option) => option.model === model.model))
      .map((model) => ({ agent, model: model.model, label: model.model }));
    return [...known, ...extra];
  }

  function said(where: Where, text: string | null) {
    refusal = text === null ? null : { at: here, where, text };
  }

  function change(where: Where, patch: StepPatch) {
    said(where, updateStep(workflow.name, index, patch));
  }

  function rename(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    change("name", { name: field.value });
    if (problem("name") !== null) field.value = step.name;
  }

  function number(event: Event, field: "parallel" | "limit") {
    const input = event.currentTarget as HTMLInputElement;
    const where: Where = field === "parallel" ? "parallel" : "back";
    change(where, { [field]: Number(input.value) } as StepPatch);
    if (problem(where) !== null) input.value = String((step as unknown as Record<string, number>)[field]);
  }

  /** A checkbox the rules refused to change goes back to what is held. */
  function settle(event: Event, held: boolean) {
    (event.currentTarget as HTMLInputElement).checked = held;
  }

  const chosen = (model: WorkflowModel) => step.models.some((held) => sameModel(held, model));

  function toggle(model: WorkflowModel) {
    const models = chosen(model)
      ? step.models.filter((held) => !sameModel(held, model))
      : [...step.models, { agent: model.agent, model: model.model }];
    change("models", { models });
  }

  /** Any model is what no choice means, so it is turned on by ticking it
      and off only by choosing a model. */
  function any(event: Event) {
    if (step.models.length > 0) change("models", { models: [] });
    settle(event, true);
  }

  function useFirst(model: WorkflowModel) {
    change("models", {
      models: [
        { agent: model.agent, model: model.model },
        ...step.models.filter((held) => !sameModel(held, model)),
      ],
    });
  }

  function kind(next: "work" | "review") {
    if (next === "review" && index === 0) return;
    said("kind", setStepKind(workflow.name, index, next));
  }

  /** The two kinds are a radio group: the arrows move between them. */
  async function kindKeys(event: KeyboardEvent) {
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const on = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!back && !on) return;
    event.preventDefault();
    kind(back ? "work" : "review");
    await tick();
    root?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }

  const first = $derived(index === 0);

  /** Why the step cannot be taken away, or null when it can. */
  const removeRefusal = $derived(removeProblem(workflow, index));

  /** A review passes the work on something, so the one condition left on
      cannot be turned off. */
  const onlyPass = $derived(
    step?.kind === "review" && step.reviewerApproves !== step.orchestratorAgrees
      ? step.reviewerApproves
        ? "approves"
        : "agrees"
      : null,
  );
  const ONLY_PASS = "One of these stays on: the work passes on at least one.";

  /** A control that would be refused does nothing; it says why instead. */
  function held(event: Event, condition: "approves" | "agrees") {
    if (onlyPass === condition) event.preventDefault();
  }

  /** A refusal is brought into view where it is said. */
  function seen(node: HTMLElement) {
    node.scrollIntoView({ block: "nearest" });
  }

  /** What removing the step would do to the reviews that go back to it. */
  const removeDetail = $derived.by(() => {
    if (!askingRemove) return null;
    const after = withoutStep(workflow, index);
    const moved = workflow.steps
      .filter((other, at) => at !== index && other.kind === "review" && other.backTo === step.name)
      .map((other) => {
        const now = after.steps.find((kept) => kept.name === other.name);
        return now?.kind === "review" ? `"${other.name}" goes back to "${now.backTo}" instead.` : null;
      })
      .filter((line) => line !== null);
    return moved.length === 0 ? null : moved.join(" ");
  });

  async function remove() {
    removing = null;
    const problemText = removeStep(workflow.name, index);
    if (problemText !== null) {
      said("remove", problemText);
      return;
    }
    onMoved(Math.max(0, index - 1));
    await tick();
    root?.querySelector<HTMLElement>('[data-testid="step-name"]')?.focus();
  }

  /** The question keeps in view in the column it opens in. */
  function shown(node: HTMLElement) {
    node.scrollIntoView({ block: "nearest" });
  }

  async function cancelRemove() {
    removing = null;
    await tick();
    root?.querySelector<HTMLElement>('[data-testid="step-remove"]')?.focus();
  }
</script>

{#snippet refused(where: Where)}
  {#if problem(where) !== null}
    <p class="error" role="alert" use:seen data-testid="step-problem" data-where={where}>{problem(where)}</p>
  {/if}
{/snippet}

{#if step !== undefined}
  <aside class="insp" aria-label="Settings of the step {step.name}" bind:this={root} data-testid="step-settings">
    <div class="cols">
      <div class="col">
        <label class="fld">
          <span class="lab">Step name</span>
          <input type="text" value={step.name} onchange={rename} data-testid="step-name" />
          {@render refused("name")}
        </label>

        <div class="fld">
          <span class="lab" id="step-kind-label">This step</span>
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div class="seg" role="radiogroup" aria-labelledby="step-kind-label" onkeydown={kindKeys}>
            <button
              type="button"
              role="radio"
              aria-checked={step.kind === "work"}
              tabindex={step.kind === "work" ? 0 : -1}
              class:on={step.kind === "work"}
              onclick={() => kind("work")}
              data-testid="step-kind-work">Does work</button
            >
            <button
              type="button"
              role="radio"
              aria-checked={step.kind === "review"}
              aria-disabled={first}
              tabindex={step.kind === "review" ? 0 : -1}
              class:on={step.kind === "review"}
              title={first ? "The first step does the work." : undefined}
              onclick={() => kind("review")}
              data-testid="step-kind-review">Reviews work</button
            >
          </div>
          {#if first}<p class="hint">The first step does the work.</p>{/if}
          {@render refused("kind")}
        </div>

        <fieldset class="fld" data-testid="step-models">
          <legend class="lab">Models it may use</legend>
          <div class="check">
            <label>
              <input
                type="checkbox"
                checked={step.models.length === 0}
                onchange={any}
                data-testid="step-model-any"
              />
              <span>Any model</span>
            </label>
          </div>
          {#each agents as agent (agent)}
            <div class="group">{AGENT_LABELS[agent]}</div>
            {#each optionsFor(agent) as option (option.model)}
              <div class="check">
                <label>
                  <input
                    type="checkbox"
                    checked={chosen(option)}
                    onchange={() => toggle(option)}
                    data-testid="step-model"
                    data-agent={option.agent}
                    data-model={option.model}
                  />
                  <span>{option.label}</span>
                </label>
                {#if chosen(option) && step.models[0] !== undefined && sameModel(step.models[0], option)}
                  <small data-testid="step-model-first">used first</small>
                {:else if chosen(option)}
                  <button
                    type="button"
                    class="plain"
                    aria-label="Use {option.label} first"
                    onclick={() => useFirst(option)}
                    data-testid="step-model-use-first">use first</button
                  >
                {/if}
              </div>
            {/each}
          {/each}
          {@render refused("models")}
        </fieldset>
      </div>

      <div class="col">
        {#if step.kind === "work"}
          <label class="fld">
            <span class="lab">Sessions at once</span>
            <input
              type="number"
              min="1"
              max={MOST_PARALLEL}
              step="1"
              value={step.parallel}
              onchange={(event) => number(event, "parallel")}
              data-testid="step-parallel"
            />
            {@render refused("parallel")}
          </label>
        {:else}
          <fieldset class="fld" data-testid="step-passes">
            <legend class="lab">The work passes when</legend>
            <div class="check" title={onlyPass === "approves" ? ONLY_PASS : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={step.reviewerApproves}
                  aria-disabled={onlyPass === "approves"}
                  aria-describedby={onlyPass === "approves" ? "step-pass-why" : undefined}
                  onclick={(event) => held(event, "approves")}
                  onchange={(event) => {
                    change("passes", { reviewerApproves: !step.reviewerApproves });
                    if (step.kind === "review") settle(event, step.reviewerApproves);
                  }}
                  data-testid="step-approves"
                />
                <span>The reviewer approves</span>
              </label>
            </div>
            <div class="check" title={onlyPass === "agrees" ? ONLY_PASS : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={step.orchestratorAgrees}
                  aria-disabled={onlyPass === "agrees"}
                  aria-describedby={onlyPass === "agrees" ? "step-pass-why" : undefined}
                  onclick={(event) => held(event, "agrees")}
                  onchange={(event) => {
                    change("passes", { orchestratorAgrees: !step.orchestratorAgrees });
                    if (step.kind === "review") settle(event, step.orchestratorAgrees);
                  }}
                  data-testid="step-agrees"
                />
                <span>The orchestrator agrees</span>
              </label>
            </div>
            {#if onlyPass !== null}<span class="sr" id="step-pass-why">{ONLY_PASS}</span>{/if}
            {@render refused("passes")}
          </fieldset>

          <fieldset class="fld">
            <legend class="lab">Otherwise</legend>
            <div class="sentence">
              <label>
                go back to
                <select
                  value={step.backTo}
                  onchange={(event) => change("back", { backTo: event.currentTarget.value })}
                  data-testid="step-back-to"
                >
                  {#each targets as option (option.name)}
                    <option value={option.name}>{option.name}</option>
                  {/each}
                </select>
              </label>
              <label>
                at most
                <input
                  type="number"
                  class="small"
                  min="1"
                  max={MOST_ROUNDS}
                  step="1"
                  value={step.limit}
                  onchange={(event) => number(event, "limit")}
                  data-testid="step-limit"
                />
              </label>
              <span>times, then ask me</span>
            </div>
            {@render refused("back")}
          </fieldset>
        {/if}

        <div class="foot">
          {#if askingRemove}
            <div use:shown>
            <ConfirmStrip
              question={`Remove the step "${step.name}"?`}
              detail={removeDetail}
              action="Remove"
              onConfirm={remove}
              onCancel={cancelRemove}
              testid="step-remove-confirm"
            />
            </div>
          {:else}
            <button
              type="button"
              class="remove"
              aria-disabled={removeRefusal !== null}
              aria-describedby={removeRefusal === null ? undefined : "step-remove-why"}
              title={removeRefusal ?? undefined}
              onclick={() => {
                if (removeRefusal === null) removing = here;
              }}
              data-testid="step-remove">Remove this step</button
            >
            {#if removeRefusal !== null}<span class="sr" id="step-remove-why">{removeRefusal}</span>{/if}
            {@render refused("remove")}
          {/if}
        </div>
      </div>
    </div>
  </aside>
{/if}

<style>
  .insp {
    container-type: inline-size;
    padding: 12px 14px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    min-width: 0;
  }

  /* One column beside the diagram; under it, where the box is wide, what
     the step is and its models on the left and how it runs on the right. */
  .cols {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  @container (min-width: 560px) {
    .cols {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px 32px;
      align-items: start;
    }
  }

  .fld {
    display: block;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .lab {
    display: block;
    padding: 0;
    margin-bottom: 5px;
    font-size: 12px;
    color: var(--ink-3);
  }

  input[type="text"],
  input[type="number"],
  select {
    box-sizing: border-box;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  select {
    height: 24px;
    padding: 0 4px 0 8px;
  }

  input[type="text"] {
    width: 100%;
  }

  input[type="number"] {
    width: 64px;
  }

  input.small {
    width: 48px;
    height: 24px;
  }

  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* A segmented control: the chosen segment is raised from the track. */
  .seg {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 2px;
    border-radius: var(--radius);
    background: var(--surface-2);
  }

  .seg button {
    padding: 3px 6px;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    background: none;
    font-family: var(--chrome);
    font-size: 12px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    white-space: nowrap;
    color: var(--ink-3);
    cursor: pointer;
  }

  .seg button.on {
    background: var(--surface);
    color: var(--ink);
    font-weight: 500;
    box-shadow: 0 0 0 1px var(--divider, var(--rule));
  }

  .seg button[aria-disabled="true"] {
    opacity: 0.45;
    cursor: default;
  }

  .seg button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .hint {
    margin: 5px 0 0;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 1px 0;
    font-size: 12.5px;
    color: var(--ink);
  }

  .check label {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    cursor: pointer;
  }

  .check input {
    accent-color: var(--accent);
    margin: 0;
  }

  .check input[aria-disabled="true"] {
    opacity: 0.5;
    cursor: default;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .check small {
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .plain {
    padding: 0 2px;
    border: 0;
    border-radius: 3px;
    background: none;
    font-family: inherit;
    font-size: 11.5px;
    color: var(--ink-3);
    cursor: pointer;
  }

  .plain:hover {
    color: var(--accent);
  }

  .plain:focus-visible {
    color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .group {
    margin: 6px 0 1px;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .sentence {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 5px;
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .sentence label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .error {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--del);
  }

  .remove:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Removing is kept apart from the rest, at the foot, and asked first. */
  .foot {
    margin-top: 2px;
    padding-top: 12px;
    border-top: 1px solid var(--divider, var(--rule));
  }

  .remove {
    padding: 2px 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--del);
    cursor: pointer;
  }

  .remove:hover:not([aria-disabled="true"]) {
    text-decoration: underline;
  }

  .remove[aria-disabled="true"] {
    opacity: 0.45;
    cursor: default;
  }
</style>

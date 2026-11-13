<script lang="ts">
  /**
   * The settings of the step picked in the diagram: its name, whether it
   * does work or reviews it, the models it may use, and the settings of its
   * kind. A work step says how many sessions may run at once; a review says
   * when the work passes and where it goes back to otherwise. Each change
   * applies at once; one the rules refuse is said here and not made.
   */
  import type { Workflow, WorkflowModel } from "$lib/core";
  import { installed } from "$lib/agent.svelte";
  import { AGENT_LABELS, modelsOf, offeredAgents, sameModel } from "$lib/models";
  import {
    MOST_PARALLEL,
    MOST_ROUNDS,
    moveStep,
    removeStep,
    setStepKind,
    updateStep,
    type StepPatch,
  } from "$lib/workflows.svelte";

  interface Props {
    workflow: Workflow;
    index: number;
    /** A step was moved, so the one picked moves with it. */
    onMoved: (index: number) => void;
  }

  let { workflow, index, onMoved }: Props = $props();

  const step = $derived(workflow.steps[index]);
  const earlier = $derived(workflow.steps.slice(0, index));
  let problem = $state<string | null>(null);

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

  function change(patch: StepPatch) {
    problem = updateStep(workflow.name, index, patch);
  }

  function rename(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    change({ name: field.value });
    if (problem !== null) field.value = step.name;
  }

  function number(event: Event, field: "parallel" | "limit") {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value);
    change({ [field]: value } as StepPatch);
    if (problem !== null) input.value = String((step as unknown as Record<string, number>)[field]);
  }

  /** A checkbox the rules refused to change goes back to what is held. */
  function settle(event: Event, held: boolean) {
    if (problem !== null) (event.currentTarget as HTMLInputElement).checked = held;
  }

  const chosen = (model: WorkflowModel) => step.models.some((held) => sameModel(held, model));

  function toggle(model: WorkflowModel) {
    const models = chosen(model)
      ? step.models.filter((held) => !sameModel(held, model))
      : [...step.models, { agent: model.agent, model: model.model }];
    change({ models });
  }

  function useFirst(model: WorkflowModel) {
    change({
      models: [
        { agent: model.agent, model: model.model },
        ...step.models.filter((held) => !sameModel(held, model)),
      ],
    });
  }

  function kind(next: "work" | "review") {
    problem = setStepKind(workflow.name, index, next);
  }

  function move(by: number) {
    problem = moveStep(workflow.name, index, index + by);
    if (problem === null) onMoved(index + by);
  }

  function remove() {
    problem = removeStep(workflow.name, index);
    if (problem === null) onMoved(Math.max(0, index - 1));
  }
</script>

{#if step !== undefined}
  <aside class="insp" aria-label="Settings of {step.name}" data-testid="step-settings">
    <h4 data-testid="step-heading">{step.name}</h4>

    <label class="fld">
      <span class="lab">Name</span>
      <input type="text" value={step.name} onchange={rename} data-testid="step-name" />
    </label>

    <div class="fld">
      <span class="lab" id="step-kind-label">This step</span>
      <div class="seg" role="radiogroup" aria-labelledby="step-kind-label">
        <button
          type="button"
          role="radio"
          aria-checked={step.kind === "work"}
          class:on={step.kind === "work"}
          onclick={() => kind("work")}
          data-testid="step-kind-work">Does work</button
        >
        <button
          type="button"
          role="radio"
          aria-checked={step.kind === "review"}
          class:on={step.kind === "review"}
          disabled={index === 0}
          title={index === 0 ? "The first step does the work." : undefined}
          onclick={() => kind("review")}
          data-testid="step-kind-review">Reviews work</button
        >
      </div>
    </div>

    <fieldset class="fld" data-testid="step-models">
      <legend class="lab">Models it may use</legend>
      <label class="check">
        <input
          type="checkbox"
          checked={step.models.length === 0}
          onchange={() => change({ models: [] })}
          data-testid="step-model-any"
        />
        <span>Any model</span>
      </label>
      {#each agents as agent (agent)}
        <div class="group">{AGENT_LABELS[agent]}</div>
        {#each optionsFor(agent) as option (option.model)}
          <label class="check">
            <input
              type="checkbox"
              checked={chosen(option)}
              onchange={() => toggle(option)}
              data-testid="step-model"
              data-agent={option.agent}
              data-model={option.model}
            />
            <span>{option.label}</span>
            {#if chosen(option) && step.models[0] !== undefined && sameModel(step.models[0], option)}
              <small data-testid="step-model-first">used first</small>
            {:else if chosen(option)}
              <button
                type="button"
                class="plain"
                onclick={(event) => {
                  event.preventDefault();
                  useFirst(option);
                }}
                data-testid="step-model-use-first">use first</button
              >
            {/if}
          </label>
        {/each}
      {/each}
    </fieldset>

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
      </label>
    {:else}
      <fieldset class="fld" data-testid="step-passes">
        <legend class="lab">The work passes when</legend>
        <label class="check">
          <input
            type="checkbox"
            checked={step.reviewerApproves}
            onchange={(event) => {
              change({ reviewerApproves: !step.reviewerApproves });
              settle(event, step.reviewerApproves);
            }}
            data-testid="step-approves"
          />
          <span>The reviewer approves</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={step.orchestratorAgrees}
            onchange={(event) => {
              change({ orchestratorAgrees: !step.orchestratorAgrees });
              settle(event, step.orchestratorAgrees);
            }}
            data-testid="step-agrees"
          />
          <span>The orchestrator agrees</span>
        </label>
      </fieldset>

      <div class="fld">
        <span class="lab">Otherwise</span>
        <div class="sentence">
          <label>
            go back to
            <select
              value={step.backTo}
              onchange={(event) => change({ backTo: event.currentTarget.value })}
              data-testid="step-back-to"
            >
              {#each earlier as option (option.name)}
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
            times,
          </label>
          <span>then ask the user</span>
        </div>
      </div>
    {/if}

    {#if problem !== null}
      <p class="error" role="alert" data-testid="step-problem">{problem}</p>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="tool"
        disabled={index === 0}
        onclick={() => move(-1)}
        data-testid="step-earlier">Move earlier</button
      >
      <button
        type="button"
        class="tool"
        disabled={index === workflow.steps.length - 1}
        onclick={() => move(1)}
        data-testid="step-later">Move later</button
      >
      <button
        type="button"
        class="tool danger"
        disabled={workflow.steps.length <= 1}
        onclick={remove}
        data-testid="step-remove">Remove this step</button
      >
    </div>
  </aside>
{/if}

<style>
  .insp {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--rule);
    min-width: 0;
  }

  h4 {
    margin: 0;
    font-family: var(--chrome);
    font-size: var(--heading-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: var(--heading-weight);
    color: var(--heading-color);
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
    padding: 4px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  input[type="text"] {
    width: 100%;
  }

  input[type="number"] {
    width: 64px;
  }

  input.small {
    width: 52px;
  }

  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .seg {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .seg button {
    padding: 4px 6px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
  }

  .seg button:last-child {
    border-right: 0;
  }

  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .seg button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .seg button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    font-size: 12.5px;
    color: var(--ink);
    cursor: pointer;
  }

  .check input {
    accent-color: var(--accent);
    margin: 0;
  }

  .check small {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .plain {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    font-size: 11.5px;
    color: var(--ink-3);
    cursor: pointer;
  }

  .plain:hover,
  .plain:focus-visible {
    color: var(--accent);
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
    gap: 5px 6px;
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .sentence label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--del);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  .tool {
    padding: 2px 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
  }

  .tool:hover:not(:disabled),
  .tool:focus-visible {
    color: var(--accent);
  }

  .tool.danger:hover:not(:disabled),
  .tool.danger:focus-visible {
    color: var(--del);
  }

  .tool:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .tool:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>

<script lang="ts">
  /**
   * The Workflows tab of the settings: the workflows listed across the top,
   * one marked as the default for new sessions, the picked one drawn as a
   * diagram, what the orchestrator is told under it, and the switch that
   * makes it the default. A change applies at once, as the other settings do.
   */
  import type { WorkflowStep } from "$lib/core";
  import { instructionLines } from "$lib/workflowInstructions";
  import { projectLabel, workspace } from "$lib/workspace.svelte";
  import {
    addStep,
    addWorkflow,
    deleteWorkflow,
    duplicateWorkflow,
    overrideOf,
    renameWorkflow,
    setDefault,
    setOrchestrator,
    setOverride,
    workflowNamed,
    workflows,
  } from "$lib/workflows.svelte";
  import WorkflowDiagram from "$lib/components/WorkflowDiagram.svelte";

  /** The workflow being edited, by name; the default, else the first, when
      that one is gone. */
  let picked = $state<string | null>(workflows.default);
  const current = $derived(workflowNamed(picked) ?? workflowNamed(workflows.default) ?? workflows.list[0]);

  /** The step picked in the diagram. */
  let step = $state(0);
  const selected = $derived(current === undefined ? 0 : Math.min(step, current.steps.length - 1));

  let problem = $state<string | null>(null);
  let overridesOpen = $state(false);

  const told = $derived(current === undefined ? [] : instructionLines(current));
  const isDefault = $derived(current !== undefined && workflows.default === current.name);
  const overridden = $derived(
    workspace.open.filter((project) => overrideOf(project.path) !== undefined).length,
  );

  function choose(name: string) {
    picked = name;
    step = 0;
    problem = null;
  }

  function create() {
    const name = addWorkflow();
    if (name === null) {
      problem = "The settings hold as many workflows as they can.";
      return;
    }
    choose(name);
  }

  function duplicate() {
    if (current === undefined) return;
    const name = duplicateWorkflow(current.name);
    if (name === null) problem = "The settings hold as many workflows as they can.";
    else choose(name);
  }

  function remove() {
    if (current === undefined) return;
    const index = workflows.list.findIndex((workflow) => workflow.name === current.name);
    deleteWorkflow(current.name);
    const next = workflows.list[Math.min(index, workflows.list.length - 1)];
    picked = next?.name ?? null;
    step = 0;
    problem = null;
  }

  function rename(event: Event) {
    if (current === undefined) return;
    const field = event.currentTarget as HTMLInputElement;
    const wanted = field.value.trim();
    const old = current.name;
    problem = renameWorkflow(old, wanted);
    if (problem === null) picked = wanted;
    else field.value = old;
  }

  function add(at: number, kind: WorkflowStep["kind"]) {
    if (current === undefined) return;
    problem = addStep(current.name, at, kind);
    if (problem === null) step = at;
  }

  function switchDefault() {
    if (current === undefined) return;
    setDefault(isDefault ? null : current.name);
  }

  function choice(project: string, event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    setOverride(project, value === "@default" ? undefined : value === "@none" ? null : value);
  }

  const defaultLine = $derived(
    workflows.default === null
      ? "New sessions start with no workflow."
      : `New sessions start with ${workflows.default}.`,
  );
</script>

<section data-testid="settings-workflows">
  <h3>Workflows</h3>
  <p class="note">
    A workflow says which model a session starts on, and which models it may hand work and review to.
  </p>

  <div class="picker" role="group" aria-label="Workflows" data-testid="workflow-picker">
    {#each workflows.list as workflow (workflow.name)}
      <button
        type="button"
        class="chip"
        class:on={current?.name === workflow.name}
        aria-pressed={current?.name === workflow.name}
        onclick={() => choose(workflow.name)}
        data-testid="workflow-chip"
        data-workflow={workflow.name}
      >
        {workflow.name}
        {#if workflows.default === workflow.name}<span class="tag" data-testid="workflow-default-tag">default</span>{/if}
      </button>
    {/each}
    <button type="button" class="chip new" onclick={create} data-testid="workflow-new">+ New workflow</button>
  </div>

  {#if current === undefined}
    <p class="note quiet" data-testid="workflow-none">
      There are no workflows. New sessions start on one model with nothing to follow.
    </p>
  {:else}
    {#key current.name}
      <div class="head">
        <label class="field">
          <span class="field-what">Name</span>
          <input type="text" value={current.name} onchange={rename} data-testid="workflow-name" />
        </label>
        <button type="button" class="tool" onclick={duplicate} data-testid="workflow-duplicate">Duplicate</button>
        <button type="button" class="tool danger" onclick={remove} data-testid="workflow-delete">Delete</button>
      </div>
    {/key}
    {#if problem !== null}
      <p class="error" role="alert" data-testid="workflow-problem">{problem}</p>
    {/if}

    <div class="edit">
      <div class="drawn">
        <WorkflowDiagram
          workflow={current}
          {selected}
          onSelect={(index) => (step = index)}
          onAdd={add}
          onOrchestrator={(model) => (problem = setOrchestrator(current.name, model))}
        />

        <details class="told" data-testid="workflow-told">
          <summary data-testid="workflow-told-toggle">What the orchestrator is told</summary>
          <ol data-testid="workflow-told-list">
            {#each told as line, index (index)}<li>{line}</li>{/each}
          </ol>
        </details>
      </div>
    </div>

    <div class="foot">
      <button
        type="button"
        role="switch"
        aria-checked={isDefault}
        aria-label="New sessions start with this workflow"
        class="switch"
        class:on={isDefault}
        onclick={switchDefault}
        data-testid="workflow-default"><span class="knob"></span></button
      >
      <span>New sessions start with this workflow</span>
      <small data-testid="workflow-default-line">{defaultLine}</small>
    </div>
  {/if}

  {#if workspace.open.length > 0 && workflows.list.length > 0}
    <button
      type="button"
      class="fold"
      onclick={() => (overridesOpen = !overridesOpen)}
      aria-expanded={overridesOpen}
      data-testid="workflow-overrides"
    >
      <span class="chevron">{overridesOpen ? "▾" : "▸"}</span>
      Project choices{overridden > 0 ? ` (${overridden})` : ""}
    </button>
    {#if overridesOpen}
      <div class="projects">
        {#each workspace.open as project (project.path)}
          {@const own = overrideOf(project.path)}
          <div class="project" data-testid="workflow-project-row" data-project={project.path}>
            <span class="project-name" title={project.path}>{projectLabel(project.path)}</span>
            <select
              aria-label="The workflow for {projectLabel(project.path)}"
              value={own === undefined ? "@default" : own === null ? "@none" : own}
              onchange={(event) => choice(project.path, event)}
              data-testid="workflow-project-choice"
            >
              <option value="@default">As the default</option>
              <option value="@none">No workflow</option>
              {#each workflows.list as workflow (workflow.name)}
                <option value={workflow.name}>{workflow.name}</option>
              {/each}
            </select>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  h3 {
    margin: 0 0 6px;
    font-family: var(--chrome);
    font-size: var(--heading-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: var(--heading-weight);
    color: var(--heading-color);
  }

  .note {
    margin: 0 0 10px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .note.quiet {
    color: var(--ink-3);
  }

  .error {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--del);
  }

  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-tag);
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-2);
    cursor: pointer;
  }

  .chip:hover {
    color: var(--ink);
  }

  .chip.on {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--ink);
  }

  .chip.new {
    color: var(--ink-3);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .chip:focus-visible,
  .tool:focus-visible,
  .fold:focus-visible,
  .switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .tag {
    font-size: 10px;
    color: var(--accent);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 220px;
  }

  .field-what {
    flex: none;
    font-family: var(--chrome);
    font-size: 12px;
    color: var(--ink-2);
  }

  .field input {
    flex: 0 1 260px;
    min-width: 0;
    box-sizing: border-box;
    padding: 5px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  .tool {
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tool:hover {
    color: var(--accent);
  }

  .tool.danger:hover {
    color: var(--del);
  }

  .edit {
    container-type: inline-size;
  }

  .drawn {
    min-width: 0;
  }

  .told {
    margin-top: 12px;
  }

  .told summary {
    cursor: pointer;
    font-family: var(--chrome);
    font-size: var(--fold-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .told summary:hover {
    color: var(--ink);
  }

  .told summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .told ol {
    margin: 8px 0 0;
    padding: 10px 14px 10px 32px;
    border-radius: var(--radius);
    background: var(--surface-2);
    font-size: 12.5px;
    color: var(--ink-2);
    max-width: 70ch;
  }

  .told li + li {
    margin-top: 4px;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .foot small {
    font-size: 12px;
    color: var(--ink-3);
  }

  .switch {
    position: relative;
    flex: none;
    width: 30px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: var(--rule-strong);
    cursor: pointer;
  }

  .switch.on {
    background: var(--accent);
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--surface);
    transition: transform 0.12s;
  }

  .switch.on .knob {
    transform: translateX(12px);
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 14px 0 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--fold-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 0;
  }

  .fold:hover {
    color: var(--ink);
  }

  .projects {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }

  .project {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .project-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--chrome);
    font-size: 12px;
    color: var(--ink);
  }

  .project select {
    padding: 4px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--surface);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }
</style>

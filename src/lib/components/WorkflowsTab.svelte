<script lang="ts">
  /**
   * The Workflows tab of the settings: the workflows listed across the top,
   * one marked as the default for new sessions, and any the settings file
   * holds but cannot use, each with the rule it breaks. Under them the
   * picked one's name, its diagram, which stays in place, and the picked
   * step's settings, which scroll on their own: beside the diagram where the
   * window has room for both, and under it where it has not. What the
   * orchestrator is told and the project choices follow; the switch that
   * makes it the default and Delete, asked first, stay at the foot. A change
   * applies at once, as the other settings do; one the settings refuse is
   * said, and the window shows what is kept.
   */
  import { tick } from "svelte";
  import type { WorkflowStep } from "$lib/core";
  import { instructionLines } from "$lib/workflowInstructions";
  import { projectLabel, workspace } from "$lib/workspace.svelte";
  import {
    addStep,
    addWorkflow,
    deleteWorkflow,
    duplicateWorkflow,
    moveStep,
    overrideOf,
    removeUnread,
    renameWorkflow,
    setDefault,
    setStartOnly,
    startsOnly,
    setOrchestrator,
    setOverride,
    workflowNamed,
    workflows,
  } from "$lib/workflows.svelte";
  import WorkflowDiagram, { leastWidth } from "$lib/components/WorkflowDiagram.svelte";
  import StepSettings from "$lib/components/StepSettings.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";

  /** The width of the step's settings beside the diagram, and the gap. */
  const STEP_WIDTH = 248;
  const GAP = 14;
  /** The steps an ordinary workflow has at most: the step's settings stand
      beside the diagram where the window has room for that many. */
  const ORDINARY = 4;

  /** The workflow being edited, by name; the default, else the first, when
      that one is gone. */
  let picked = $state<string | null>(workflows.default);
  const current = $derived(workflowNamed(picked) ?? workflowNamed(workflows.default) ?? workflows.list[0]);

  /** The step picked in the diagram. */
  let step = $state(0);
  const selected = $derived(current === undefined ? 0 : Math.min(step, current.steps.length - 1));

  let problem = $state<string | null>(null);
  let overridesOpen = $state(false);
  /** The workflow Delete is asking about, by name. */
  let deleting = $state<string | null>(null);
  /** The unread entry Remove is asking about, by where it stands. */
  let dropping = $state<number | null>(null);

  /** Beside or under is the window's to decide, never the step count's. */
  let editWidth = $state(0);
  const beside = $derived(editWidth >= leastWidth(ORDINARY) + GAP + STEP_WIDTH);

  const told = $derived(current === undefined ? [] : instructionLines(current));
  const isDefault = $derived(current !== undefined && workflows.default === current.name);
  const overridden = $derived(
    workspace.open.filter((project) => overrideOf(project.path) !== undefined).length,
  );

  function choose(name: string) {
    picked = name;
    step = 0;
    problem = null;
    deleting = null;
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

  /** What deleting the picked workflow does besides. */
  const deleteDetail = $derived.by(() => {
    if (current === undefined) return null;
    const name = current.name;
    const lines: string[] = [];
    if (workflows.default === name) lines.push("New sessions will start with no workflow.");
    const choosers = Object.entries(workflows.overrides).filter(([, choice]) => choice === name).length;
    if (choosers === 1) lines.push("The project that chose it follows the default again.");
    if (choosers > 1) lines.push(`The ${choosers} projects that chose it follow the default again.`);
    return lines.length === 0 ? null : lines.join(" ");
  });

  async function remove() {
    if (current === undefined) return;
    const index = workflows.list.findIndex((workflow) => workflow.name === current.name);
    deleteWorkflow(current.name);
    const next = workflows.list[Math.min(index, workflows.list.length - 1)];
    deleting = null;
    picked = next?.name ?? null;
    step = 0;
    problem = null;
    await tick();
    document
      .querySelector<HTMLElement>('[data-testid="workflow-chip"][aria-pressed="true"], [data-testid="workflow-new"]')
      ?.focus();
  }

  async function cancelDelete() {
    deleting = null;
    await tick();
    document.querySelector<HTMLElement>('[data-testid="workflow-delete"]')?.focus();
  }

  function rename(event: Event) {
    if (current === undefined) return;
    const field = event.currentTarget as HTMLInputElement;
    const wanted = field.value.trim();
    const old = current.name;
    problem = renameWorkflow(old, wanted);
    if (problem === null) {
      picked = wanted;
      if (deleting === old) deleting = wanted;
    }
    field.value = problem === null ? wanted : old;
  }

  /** Puts the keyboard on a step of the diagram, by name. */
  async function focusStep(name: string) {
    await tick();
    document.querySelector<HTMLElement>(`[data-testid="workflow-step"][data-step="${CSS.escape(name)}"]`)?.focus();
  }

  /** A step added is picked and has the keyboard. */
  function add(at: number, kind: WorkflowStep["kind"]) {
    if (current === undefined) return;
    problem = addStep(current.name, at, kind);
    if (problem !== null) return;
    step = at;
    const added = current.steps[at];
    if (added !== undefined) void focusStep(added.name);
  }

  /** A step moved stays picked, and the keyboard stays where it was. */
  async function move(from: number, to: number, focus: string | null) {
    if (current === undefined) return;
    const name = current.steps[from]?.name;
    problem = moveStep(current.name, from, to);
    if (problem !== null || name === undefined) return;
    step = to;
    await tick();
    const node = document.querySelector<HTMLElement>(
      focus === null
        ? `[data-testid="workflow-step"][data-step="${CSS.escape(name)}"]`
        : `[data-testid="${focus}"]`,
    );
    node?.focus();
  }

  function switchDefault() {
    if (current === undefined) return;
    setDefault(isDefault ? null : current.name);
  }

  function choice(project: string, event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    setOverride(project, value === "@default" ? undefined : value === "@none" ? null : value);
  }

  /** Where new sessions stand, said beside the switch. */
  const defaultLine = $derived(
    isDefault
      ? workspace.open.length > 0
        ? "New sessions start with this workflow. A project can choose another under Project choices."
        : "New sessions start with this workflow."
      : workflows.default === null
        ? "New sessions start with no workflow."
        : `New sessions start with ${workflows.default}.`,
  );

  /** After a notice of an unread workflow is answered, the keyboard goes
      to the next notice, else to the workflow picked. */
  async function afterNotice(at: number, kept: boolean) {
    dropping = null;
    if (!kept) removeUnread(at);
    await tick();
    const own = document.querySelector<HTMLElement>(
      `[data-testid="workflow-unread"][data-at="${at}"] [data-testid="workflow-unread-remove"]`,
    );
    const next =
      own ??
      document.querySelector<HTMLElement>('[data-testid="workflow-unread-remove"]') ??
      document.querySelector<HTMLElement>('[data-testid="workflow-chip"][aria-pressed="true"], [data-testid="workflow-new"]');
    next?.focus();
  }

  /** Whether a scrolling part has more below what shows, kept up to date as
      it scrolls and as its content changes. */
  let moreBelow = $state(false);
  function watchBelow(node: HTMLElement) {
    const measure = () => {
      moreBelow = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    };
    const sizes = new ResizeObserver(measure);
    sizes.observe(node);
    const changes = new MutationObserver(measure);
    changes.observe(node, { childList: true, subtree: true, attributes: true });
    node.addEventListener("scroll", measure);
    measure();
    return {
      destroy() {
        sizes.disconnect();
        changes.disconnect();
        node.removeEventListener("scroll", measure);
      },
    };
  }

  /** What an unread workflow was still named for. */
  function unreadDetail(entry: (typeof workflows.unread)[number]): string {
    const parts: string[] = [];
    if (entry.default) parts.push("The file names it for new sessions, which start with no workflow until it is mended.");
    if (entry.projects.length === 1) parts.push("One project chose it.");
    if (entry.projects.length > 1) parts.push(`${entry.projects.length} projects chose it.`);
    return parts.join(" ");
  }
</script>

{#snippet more()}
  {#if current !== undefined}
    <label class="own" data-testid="workflow-start-only-row">
      <input
        type="checkbox"
        checked={startsOnly(current)}
        onchange={(event) => (problem = setStartOnly(current.name, event.currentTarget.checked))}
        data-testid="workflow-start-only"
      />
      <span>
        <span class="own-label">Hand out work only as sessions you can see</span>
        <small>
          {startsOnly(current)
            ? "The orchestrator's own ways to hand work to agents you cannot see are taken away, so every piece it hands out is a session you can see."
            : "The orchestrator keeps its own subagents, whose work does not show as sessions."}
        </small>
      </span>
    </label>
  {/if}

  <details class="told" data-testid="workflow-told">
    <summary data-testid="workflow-told-toggle">
      <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      What the orchestrator is told
    </summary>
    <ol data-testid="workflow-told-list">
      {#each told as line, index (index)}<li>{line}</li>{/each}
    </ol>
  </details>

  {#if workspace.open.length > 0 && workflows.list.length > 0}
    <button
      type="button"
      class="fold"
      onclick={() => (overridesOpen = !overridesOpen)}
      aria-expanded={overridesOpen}
      data-testid="workflow-overrides"
    >
      <svg class="chev" class:open={overridesOpen} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
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
              <option value="@default">As for new sessions</option>
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
{/snippet}

<section class="tab" data-testid="settings-workflows">
  <div class="top">
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
          <span>{workflow.name}</span>
          {#if workflows.default === workflow.name}<span class="tag" data-testid="workflow-default-tag">default</span>{/if}
        </button>
      {/each}
      <button type="button" class="chip new" onclick={create} data-testid="workflow-new">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>New workflow
      </button>
    </div>

    {#each workflows.unread as entry (entry.at)}
      <div class="unread" role="status" data-testid="workflow-unread" data-at={entry.at}>
        {#if dropping === entry.at}
          <ConfirmStrip
            question={`Remove "${entry.name ?? "the unnamed workflow"}" from the settings file?`}
            detail="It cannot be used as it is written."
            action="Remove"
            onConfirm={() => afterNotice(entry.at, false)}
            onCancel={() => afterNotice(entry.at, true)}
            testid="workflow-unread-confirm"
          />
        {:else}
          <p>
            <b>"{entry.name ?? "A workflow without a name"}" in the settings file is not used.</b>
            It breaks a rule: {entry.reason}. {unreadDetail(entry)} The file keeps it as written until you
            mend it there or remove it.
          </p>
          <button type="button" class="drop" onclick={() => (dropping = entry.at)} data-testid="workflow-unread-remove"
            >Remove from the file</button
          >
        {/if}
      </div>
    {/each}

    {#if workflows.refused !== null}
      <p class="error" role="alert" data-testid="workflow-refused">
        The change was not kept: {workflows.refused}. The settings show what is stored.
      </p>
    {/if}

    {#if current !== undefined}
      <div class="head">
        <label class="field">
          <span class="lab">Workflow name</span>
          <input type="text" value={current.name} onchange={rename} data-testid="workflow-name" />
        </label>
        <button type="button" class="tool" onclick={duplicate} data-testid="workflow-duplicate">Duplicate</button>
      </div>
    {/if}
    {#if problem !== null}
      <p class="error" role="alert" data-testid="workflow-problem">{problem}</p>
    {/if}
  </div>

  {#if current === undefined}
    <p class="note quiet" data-testid="workflow-none">
      There are no workflows. New sessions start on one model with nothing to follow.
    </p>
  {:else}
    <div class="edit" class:beside bind:clientWidth={editWidth} data-testid="workflow-edit">
      <div class="drawn">
        <WorkflowDiagram
          workflow={current}
          {selected}
          onSelect={(index) => (step = index)}
          onAdd={add}
          onMove={move}
          onOrchestrator={(model) => (problem = setOrchestrator(current.name, model))}
        />
      </div>

      {#if beside}
        <div class="scroll-box step-box">
          <div class="step" use:watchBelow data-testid="workflow-step-pane">
            <StepSettings workflow={current} index={selected} onMoved={(index) => (step = index)} />
          </div>
          {#if moreBelow}<div class="more-below" aria-hidden="true" data-testid="workflow-step-more"></div>{/if}
        </div>
        <div class="rest">{@render more()}</div>
      {:else}
        <div class="scroll-box">
          <div class="below" use:watchBelow data-testid="workflow-step-pane">
            <StepSettings workflow={current} index={selected} onMoved={(index) => (step = index)} />
            {@render more()}
          </div>
          {#if moreBelow}<div class="more-below" aria-hidden="true" data-testid="workflow-step-more"></div>{/if}
        </div>
      {/if}
    </div>

    <div class="foot">
      <button
        type="button"
        role="switch"
        aria-checked={isDefault}
        aria-labelledby="workflow-default-label"
        class="switch"
        class:on={isDefault}
        onclick={switchDefault}
        data-testid="workflow-default"><span class="knob"></span></button
      >
      <span id="workflow-default-label" class="switch-label">Use for new sessions</span>
      <small data-testid="workflow-default-line">{defaultLine}</small>
      <button
        type="button"
        class="delete"
        aria-expanded={deleting === current.name}
        onclick={() => (deleting = current.name)}
        data-testid="workflow-delete">Delete workflow</button
      >
    </div>
    {#if deleting === current.name}
      <div class="confirm">
        <ConfirmStrip
          question={`Delete the workflow "${current.name}"?`}
          detail={deleteDetail}
          action="Delete"
          onConfirm={remove}
          onCancel={cancelDelete}
          testid="workflow-delete-confirm"
        />
      </div>
    {/if}
  {/if}
</section>

<style>
  /* The tab fills the dialog: its head and foot stay, the diagram stays,
     and only what is under or beside the diagram scrolls. */
  .tab {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .top,
  .foot,
  .confirm {
    flex: none;
  }

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
    gap: 5px;
    color: var(--ink-3);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .chip svg,
  .chev {
    width: 11px;
    height: 11px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .chip:focus-visible,
  .tool:focus-visible,
  .delete:focus-visible,
  .fold:focus-visible,
  .switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* The default's tag is a badge of its own, so it never reads as part of
     the name. */
  .tag {
    padding: 0 5px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    font-size: 10px;
    line-height: 15px;
    letter-spacing: 0;
    color: var(--accent);
  }

  .head {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    flex: 0 1 300px;
    min-width: 0;
  }

  .lab {
    display: block;
    margin-bottom: 5px;
    font-size: 12px;
    color: var(--ink-3);
  }

  .field input {
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

  .field input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .tool {
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-2);
    cursor: pointer;
    height: 28px;
    padding: 0 4px;
  }

  .tool:hover {
    color: var(--accent);
  }

  /* The diagram stays at the top of the editor. Beside it, where the window
     has room for an ordinary workflow and the step's settings together, the
     settings scroll on their own; otherwise they scroll under it, with what
     the orchestrator is told and the project choices after them. */
  .edit {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: 12px 14px;
  }

  .edit.beside {
    grid-template-columns: minmax(0, 1fr) 248px;
    grid-template-areas: "drawn step" "rest step";
  }

  .drawn {
    min-width: 0;
  }

  .beside .drawn {
    grid-area: drawn;
  }

  /* A part that scrolls fades out at its foot while there is more below. */
  .scroll-box {
    position: relative;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .step-box {
    grid-area: step;
  }

  .more-below {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 36px;
    pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--surface));
  }

  .step {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 2px 2px 0;
  }

  .rest,
  .below {
    min-height: 0;
    overflow-y: auto;
  }

  .rest {
    grid-area: rest;
  }

  .below {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 4px;
  }

  .told {
    min-width: 0;
  }

  .told summary {
    display: flex;
    align-items: center;
    gap: 6px;
    width: max-content;
    list-style: none;
    cursor: pointer;
    font-family: var(--chrome);
    font-size: var(--fold-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .told summary::-webkit-details-marker {
    display: none;
  }

  .chev {
    transition: transform 0.15s;
  }

  .told[open] .chev {
    transform: rotate(90deg);
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

  /* Whether the orchestrator keeps its own subagents: a box and two lines. */
  .own {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0 0 12px;
    cursor: pointer;
  }
  .own input {
    margin: 2px 0 0;
    accent-color: var(--accent);
  }
  .own > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .own small {
    color: var(--ink-3);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .switch-label {
    color: var(--ink);
  }

  .foot small {
    flex: 1 1 220px;
    font-size: 12px;
    color: var(--ink-3);
  }

  /* Delete stands alone at the far end of the foot, away from Duplicate,
     and is asked first. */
  .delete {
    margin-left: auto;
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

  .delete:hover {
    text-decoration: underline;
  }

  .confirm {
    margin-top: 10px;
  }

  .unread {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px 12px;
    margin: 0 0 12px;
    padding: 8px 10px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--del) 45%, transparent);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
  }

  .unread p {
    flex: 1 1 320px;
    margin: 0;
  }

  .unread b {
    font-weight: 600;
    color: var(--ink);
  }

  .unread :global([role="alertdialog"]) {
    flex: 1;
  }

  .drop {
    flex: none;
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

  .drop:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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
    gap: 6px;
    margin: 12px 0 0;
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

  .chev.open {
    transform: rotate(90deg);
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

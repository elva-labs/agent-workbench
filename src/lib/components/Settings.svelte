<script lang="ts">
  import { onMount } from "svelte";
  import {
    ACTIONS,
    PRESET_LABELS,
    PRESETS,
    applyPreset,
    chordFromEvent,
    describe,
    keys,
    resetBinding,
    setBinding,
    type ActionKey,
    type PresetName,
  } from "$lib/keys.svelte";
  import { returnFocus } from "$lib/layout.svelte";
  import { closeSettings } from "$lib/settings.svelte";
  import { hook, overrideOf, setEverywhere, setOverride } from "$lib/hook.svelte";
  import { workspace, projectLabel } from "$lib/workspace.svelte";
  import {
    PALETTES,
    resolvedTheme,
    setPalette,
    setTheme,
    theme,
    type ThemeChoice,
  } from "$lib/theme.svelte";

  /**
   * The settings, over the workbench. Reached from the native menu or its
   * chord; closed on Escape or a click outside. Everything in it takes effect
   * as it is changed and is kept, so there is nothing to save or cancel.
   */

  const THEMES: { choice: ThemeChoice; label: string; hint: string }[] = [
    { choice: "system", label: "System", hint: "Follows the desktop" },
    { choice: "light", label: "Light", hint: "" },
    { choice: "dark", label: "Dark", hint: "" },
  ];

  const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

  let dialog: HTMLElement;
  /** The action whose chord is being recorded, if any. */
  let recording = $state<ActionKey | null>(null);
  let problem = $state<{ action: ActionKey; text: string } | null>(null);

  // The keyboard is taken on the way in and handed back on the way out,
  // whichever way the dialog closed.
  onMount(() => {
    dialog.focus();
    return returnFocus;
  });

  /** How many open projects have a word of their own. */
  let overridden = $derived(
    workspace.open.filter((project) => overrideOf(project.path) !== null).length,
  );
  // The overrides are the rare case: folded away unless one is in use.
  let overridesOpen = $state(false);
  $effect(() => {
    if (overridden > 0) overridesOpen = true;
  });

  /** The answer for every project, applied to the open ones at once. */
  function setHooksEverywhere(on: boolean) {
    if (hook.everywhere !== on) {
      void setEverywhere(
        on,
        workspace.open.map((project) => project.path),
      );
    }
  }

  /** A project's own word, or none to follow the rest; asking for what it has is nothing. */
  function setHooks(path: string, value: boolean | null) {
    if (overrideOf(path) !== value) void setOverride(path, value);
  }

  function record(action: ActionKey) {
    recording = action;
    problem = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (recording !== null) {
      // Every key is ours while recording: the chord, or Escape to give up.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = null;
        return;
      }
      const chord = chordFromEvent(e);
      if (chord === null) return;
      const text = setBinding(recording, chord);
      problem = text === null ? null : { action: recording, text };
      recording = null;
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    }
  }

  function reset(action: ActionKey) {
    const text = resetBinding(action);
    problem = text === null ? null : { action, text };
  }

  const groups = $derived(
    ACTIONS.reduce<{ name: string; actions: typeof ACTIONS }[]>((out, action) => {
      const last = out[out.length - 1];
      if (last?.name === action.group) last.actions.push(action);
      else out.push({ name: action.group, actions: [action] });
      return out;
    }, []),
  );
</script>

<!-- A click on the scrim closes, as Escape does; the dialog itself takes
     the keyboard, so Escape is handled there. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="scrim" onclick={closeSettings} data-testid="settings-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="settings"
  >
    <header>
      <h2 id="settings-title">Settings</h2>
      <button class="tool" onclick={closeSettings} data-testid="settings-close">Esc</button>
    </header>

    <div class="body">
      <h3>Appearance</h3>
      <div class="seg" role="radiogroup" aria-label="Appearance">
        {#each THEMES as option (option.choice)}
          <button
            role="radio"
            aria-checked={theme.choice === option.choice}
            class:on={theme.choice === option.choice}
            onclick={() => setTheme(option.choice)}
            title={option.hint}
            data-testid="theme-{option.choice}">{option.label}</button
          >
        {/each}
      </div>

      <h3>Colour</h3>
      <div class="swatches" role="radiogroup" aria-label="Colour">
        {#each PALETTES as palette (palette.name)}
          <button
            class="swatch"
            role="radio"
            aria-checked={theme.palette === palette.name}
            class:on={theme.palette === palette.name}
            onclick={() => setPalette(palette.name)}
            data-testid="palette-{palette.name}"
          >
            <span
              class="dot"
              style:background={resolvedTheme() === "dark" ? palette.swatch.dark : palette.swatch.light}
            ></span>
            {palette.label}
          </button>
        {/each}
      </div>

      <h3>Live updates</h3>
      <p class="note">
        The watcher sees every change in the project. Agent hooks, written into the project's
        <code>.claude</code> and <code>.codex</code> settings and kept out of its repository,
        also report edits the moment they happen, say exactly when a session is working,
        waiting or asking for permission, and give the agent tools to open a file in the
        viewer at the lines it means and to present images it made. The choice for every project applies to each one you
        open, and a project can say otherwise under the overrides.
      </p>
      <div class="project" data-testid="hooks-everywhere">
        <span class="project-name">Every project</span>
        <div class="seg" role="radiogroup" aria-label="Live updates in every project">
          <button
            role="radio"
            aria-checked={!hook.everywhere}
            class:on={!hook.everywhere}
            onclick={() => setHooksEverywhere(false)}
            disabled={hook.busy}
            data-testid="hooks-everywhere-off">Watcher only</button
          >
          <button
            role="radio"
            aria-checked={hook.everywhere}
            class:on={hook.everywhere}
            onclick={() => setHooksEverywhere(true)}
            disabled={hook.busy}
            data-testid="hooks-everywhere-on">Agent hooks</button
          >
        </div>
      </div>
      {#if workspace.open.length === 0}
        <p class="note quiet" data-testid="hooks-none">Every project you open follows that.</p>
      {:else}
        <button
          class="fold"
          onclick={() => (overridesOpen = !overridesOpen)}
          aria-expanded={overridesOpen}
          data-testid="hooks-overrides"
        >
          <span class="chevron">{overridesOpen ? "▾" : "▸"}</span>
          Project overrides{overridden > 0 ? ` (${overridden})` : ""}
        </button>
      {/if}
      {#if overridesOpen}
        <div class="projects">
          {#each workspace.open as project (project.path)}
          {@const own = overrideOf(project.path)}
          <div class="project" data-testid="hooks-row" data-project={project.path}>
            <span class="project-name" title={project.path}>{projectLabel(project.path)}</span>
            <div class="seg" role="radiogroup" aria-label="Live updates for {projectLabel(project.path)}">
              <button
                role="radio"
                aria-checked={own === null}
                class:on={own === null}
                onclick={() => setHooks(project.path, null)}
                disabled={hook.busy}
                data-testid="hooks-default">As every project</button
              >
              <button
                role="radio"
                aria-checked={own === false}
                class:on={own === false}
                onclick={() => setHooks(project.path, false)}
                disabled={hook.busy}
                data-testid="hooks-off">Watcher only</button
              >
              <button
                role="radio"
                aria-checked={own === true}
                class:on={own === true}
                onclick={() => setHooks(project.path, true)}
                disabled={hook.busy}
                data-testid="hooks-on">Agent hooks</button
              >
            </div>
          </div>
        {/each}
        </div>
      {/if}
      {#if hook.error}
        <p class="error" data-testid="hook-error">{hook.error}</p>
      {/if}

      <h3>Keys</h3>
      <p class="note">
        Every chord carries {describe({ key: "", shift: false, alt: false }).replace(/\+$/, "")}: the
        keys without it belong to the agent. Pick a preset, or click a chord and press a new one.
      </p>
      <div class="seg" role="radiogroup" aria-label="Preset">
        {#each PRESET_NAMES as name (name)}
          <button
            role="radio"
            aria-checked={keys.preset === name}
            class:on={keys.preset === name}
            onclick={() => applyPreset(name)}
            data-testid="preset-{name}">{PRESET_LABELS[name]}</button
          >
        {/each}
        {#if keys.preset === "custom"}
          <span class="custom" data-testid="preset-custom">Custom</span>
        {/if}
      </div>

      <table class="bindings">
        {#each groups as group (group.name)}
          <tbody>
            <tr class="group"><th colspan="3">{group.name}</th></tr>
            {#each group.actions as action (action.key)}
              <tr class:problem={problem?.action === action.key}>
                <td class="label">{action.label}</td>
                <td>
                  <button
                    class="chord"
                    class:recording={recording === action.key}
                    onclick={() => record(action.key)}
                    aria-label="Change the key for {action.label}"
                    data-testid="chord-{action.key}"
                  >
                    {recording === action.key ? "Press keys…" : describe(keys.bindings[action.key])}
                  </button>
                </td>
                <td>
                  <button
                    class="tool"
                    onclick={() => reset(action.key)}
                    aria-label="Reset the key for {action.label}"
                    data-testid="reset-{action.key}">reset</button
                  >
                </td>
              </tr>
              {#if problem?.action === action.key}
                <tr class="explain">
                  <td colspan="3" data-testid="chord-problem">{problem.text}</td>
                </tr>
              {/if}
            {/each}
          </tbody>
        {/each}
      </table>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8vh;
  }

  .dialog {
    width: min(640px, calc(100vw - 48px));
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--accent);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    outline: none;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  h2 {
    margin: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    font-weight: 500;
    color: var(--accent);
  }

  .body {
    overflow-y: auto;
    padding: 6px var(--pane-pad) 16px;
  }

  h3 {
    margin: 14px 0 6px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    font-weight: 500;
    color: var(--ink-3);
  }

  .note {
    margin: 0 0 8px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .note code {
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .note.quiet {
    color: var(--ink-3);
  }

  .projects {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 12px 0 0;
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 0;
  }

  .fold:hover {
    color: var(--ink);
  }

  .project {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .project-name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--del);
    max-width: 64ch;
  }

  .seg {
    display: inline-flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--rule);
  }

  .seg button {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 10px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .seg button:last-of-type {
    border-right: 0;
  }

  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .swatch {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .swatch.on {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }

  .custom {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 10px;
    color: var(--accent);
    border-left: 1px solid var(--rule);
  }

  .bindings {
    width: 100%;
    margin-top: 10px;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .bindings th {
    text-align: left;
    padding: 12px 0 4px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    font-weight: 500;
    color: var(--ink-3);
  }

  .bindings td {
    padding: 3px 0;
    border-top: 1px solid var(--rule);
    color: var(--ink-2);
  }

  .bindings td.label {
    width: 60%;
  }

  .chord {
    min-width: 96px;
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 2px 8px;
    border: 1px solid var(--rule);
    background: var(--surface-2);
    color: var(--ink);
    cursor: pointer;
    text-align: left;
  }

  .chord.recording {
    border-color: var(--accent);
    color: var(--accent);
  }

  .tool {
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tool:hover {
    color: var(--accent);
  }

  tr.problem td {
    color: var(--del);
  }

  tr.explain td {
    border-top: 0;
    padding: 0 0 6px;
    font-size: 12px;
    color: var(--del);
  }
</style>

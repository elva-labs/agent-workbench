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
  import { closeSettings, settings } from "$lib/settings.svelte";
  import {
    addSource,
    checkAll,
    checkSource,
    enablePlugin,
    loadPlugins,
    plugins,
    removeSource,
    stateLabel,
    summary,
    trust,
    trusted,
    updateSource,
  } from "$lib/plugins.svelte";
  import { lastSegment } from "$lib/paths";
  import { hook, overrideOf, setEverywhere, setOverride } from "$lib/hook.svelte";
  import { workspace, projectLabel } from "$lib/workspace.svelte";
  import {
    INTERFACE_FONTS,
    LOOKS,
    PALETTES,
    TERMINAL_FONTS,
    resolvedTheme,
    setLook,
    setMono,
    setPalette,
    setSans,
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

  /** The plugin sources, read when the dialog opens. */
  onMount(() => {
    void loadPlugins();
  });

  let sourceLocation = $state("");
  let sourceReference = $state("");
  /** The plugin whose question is on screen: enabling it means agreeing
      to what it declares. Asked once per plugin. */
  let asking = $state<{ id: string; name: string } | null>(null);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const location = sourceLocation.trim();
    if (location === "" || plugins.busy) return;
    const added = await addSource(location, sourceReference.trim() || null);
    if (added) {
      sourceLocation = "";
      sourceReference = "";
    }
  }

  function turn(id: string, name: string, on: boolean) {
    if (!on) {
      asking = null;
      void enablePlugin(id, name, false);
      return;
    }
    if (trusted(id, name)) {
      void enablePlugin(id, name, true);
      return;
    }
    asking = { id, name };
  }

  function agree(id: string, name: string) {
    trust(id, name);
    asking = null;
    void enablePlugin(id, name, true);
  }

  /** The live updates section, lit for a moment when the dialog was opened
      to point at it. */
  let live: HTMLElement;
  let lit = $state(false);
  onMount(() => {
    if (settings.highlight !== "hooks") return;
    settings.highlight = null;
    live.scrollIntoView({ block: "center" });
    lit = true;
    const timer = setTimeout(() => (lit = false), 2600);
    return () => clearTimeout(timer);
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

      <h3>Theme</h3>
      <div class="looks" role="radiogroup" aria-label="Theme">
        {#each LOOKS as look (look.name)}
          <button
            class="look"
            role="radio"
            aria-checked={theme.look === look.name}
            class:on={theme.look === look.name}
            onclick={() => setLook(look.name)}
            data-testid="look-{look.name}"
          >
            <span class="look-name">{look.label}</span>
            <span class="look-hint">{look.hint}</span>
          </button>
        {/each}
      </div>

      <h3>Font</h3>
      <div class="fonts">
        <div class="font-row">
          <span class="font-what">Terminal</span>
          <div class="swatches" role="radiogroup" aria-label="Terminal font">
            {#each TERMINAL_FONTS as font (font.name)}
              <button
                class="swatch face"
                role="radio"
                aria-checked={theme.mono === font.name}
                class:on={theme.mono === font.name}
                onclick={() => setMono(font.name)}
                data-testid="mono-{font.name}"
              >
                <span style:font-family={font.family}>{font.label}</span>
                {#if font.hint}<span class="face-hint">{font.hint}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
        <div class="font-row">
          <span class="font-what">Interface</span>
          <div class="swatches" role="radiogroup" aria-label="Interface font">
            {#each INTERFACE_FONTS as font (font.name)}
              <button
                class="swatch face"
                role="radio"
                aria-checked={theme.sans === font.name}
                class:on={theme.sans === font.name}
                onclick={() => setSans(font.name)}
                data-testid="sans-{font.name}"
              >
                <span style:font-family={font.family}>{font.label}</span>
                {#if font.hint}<span class="face-hint">{font.hint}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
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

      <section class="live" class:lit bind:this={live} data-testid="settings-live">
      <h3>Live updates</h3>
      <p class="note">
        The watcher sees every change in the project. Agent hooks, written into the project's
        <code>.claude</code> and <code>.codex</code> settings and kept out of its repository,
        let the agent do more: say when it is working or waiting, point at code in the viewer,
        present images and documents, and more.
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
      </section>

      <h3>Plugins</h3>
      <p class="note">
        A plugin comes from a git repository or a directory on this machine, runs with your
        privileges where the project is, and adds tools for the agent, a section under the tree,
        or a view. Add a source and turn its plugins on one by one.
      </p>
      <form class="add-source" onsubmit={add}>
        <input
          type="text"
          placeholder="Repository URL or directory"
          bind:value={sourceLocation}
          disabled={plugins.busy}
          data-testid="plugin-location"
        />
        <input
          type="text"
          class="reference"
          placeholder="ref"
          bind:value={sourceReference}
          disabled={plugins.busy}
          data-testid="plugin-reference"
        />
        <button type="submit" disabled={plugins.busy || sourceLocation.trim() === ""} data-testid="plugin-add"
          >{plugins.busy ? "Working…" : "Add"}</button
        >
      </form>
      {#if plugins.error}
        <p class="error" data-testid="plugin-error">{plugins.error}</p>
      {/if}
      {#if plugins.sources.length > 0}
        <div class="sources-tools">
          <button class="tool" onclick={() => void checkAll()} disabled={plugins.busy} data-testid="plugins-check-all"
            >Check for updates</button
          >
        </div>
      {/if}
      {#each plugins.sources as source (source.id)}
        <div class="source" data-testid="plugin-source" data-source={source.id}>
          <div class="source-head">
            <span class="source-name" title={source.location}>{lastSegment(source.location)}</span>
            <span class="source-meta">
              {source.kind === "dir" ? "directory" : (source.commit?.slice(0, 7) ?? "")}{source.reference
                ? ` · ${source.reference}`
                : ""}
            </span>
            {#if source.newer}
              <button class="tool accent" onclick={() => void updateSource(source.id)} disabled={plugins.busy} data-testid="plugin-update"
                >Update to {source.newer.slice(0, 7)}</button
              >
            {/if}
            {#if source.kind === "git"}
              <button class="tool" onclick={() => void checkSource(source.id)} disabled={plugins.busy} data-testid="plugin-check"
                >Check</button
              >
            {/if}
            <button class="tool" onclick={() => void removeSource(source.id)} disabled={plugins.busy} data-testid="plugin-remove"
              >Remove</button
            >
          </div>
          {#if source.error}
            <p class="error">{source.error}</p>
          {/if}
          {#each source.plugins as plugin (plugin.name)}
            <div class="project plugin" data-testid="plugin-row" data-plugin={plugin.name}>
              <div class="plugin-text">
                <span class="project-name">{plugin.name} <span class="version">{plugin.version}</span></span>
                {#if plugin.description}<span class="plugin-desc">{plugin.description}</span>{/if}
                <span class="plugin-meta" data-testid="plugin-state">{summary(plugin)} · {stateLabel(plugin)}</span>
              </div>
              <div class="seg" role="radiogroup" aria-label="{plugin.name} on or off">
                <button
                  role="radio"
                  aria-checked={!plugin.enabled}
                  class:on={!plugin.enabled}
                  onclick={() => turn(source.id, plugin.name, false)}
                  disabled={plugins.busy}
                  data-testid="plugin-off">Off</button
                >
                <button
                  role="radio"
                  aria-checked={plugin.enabled}
                  class:on={plugin.enabled}
                  onclick={() => turn(source.id, plugin.name, true)}
                  disabled={plugins.busy}
                  data-testid="plugin-on">On</button
                >
              </div>
            </div>
            {#if asking !== null && asking.id === source.id && asking.name === plugin.name}
              <div class="ask" data-testid="plugin-ask">
                <p>
                  {plugin.name} runs <code>{plugin.run[0]}</code> with your privileges: {summary(plugin)}.
                  Turn it on?
                </p>
                <div class="ask-actions">
                  <button class="go" onclick={() => agree(source.id, plugin.name)} data-testid="plugin-agree">Turn on</button>
                  <button class="tool" onclick={() => (asking = null)} data-testid="plugin-cancel">Not now</button>
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/each}

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

  /* The section keeps the rhythm of the rest, with room around it for the
     line that lights up when the dialog was opened to point at it. */
  .live {
    margin: 22px -10px 0;
    padding: 10px 10px 10px;
    outline: 1px solid transparent;
    outline-offset: -1px;
  }

  .live h3 {
    margin-top: 0;
  }

  .live.lit {
    animation: lit 2.6s ease-out forwards;
  }

  @keyframes lit {
    0%,
    45% {
      outline-color: var(--accent);
    }
    100% {
      outline-color: transparent;
    }
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

  /* A look is a choice with a sentence under it, so it takes a box of its
     own rather than a place in a segmented control. */
  .looks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .look {
    flex: 1 1 240px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    text-align: left;
    padding: 6px 10px 7px;
    border: 1px solid var(--rule);
    background: none;
    cursor: pointer;
  }

  .look-name {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .look-hint {
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-3);
  }

  .look.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .look.on .look-name {
    color: var(--accent);
  }

  .look.on .look-hint {
    color: var(--ink-2);
  }

  .fonts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .font-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .font-what {
    flex: 0 0 68px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  /* The name of a family is set in that family, so the choice can be seen. */
  .swatch.face {
    gap: 6px;
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    padding: 4px 10px;
  }

  .face-hint {
    font-family: var(--sans);
    font-size: 11px;
    color: var(--ink-3);
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
  /* Plugin sources: a form to add one, then each source with its plugins. */
  .add-source {
    display: flex;
    gap: 6px;
    margin: 0 0 8px;
  }

  .add-source input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 11.5px;
    padding: 5px 8px;
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--ink);
  }

  .add-source input.reference {
    flex: 0 0 80px;
  }

  .add-source button,
  .sources-tools .tool,
  .source-head .tool,
  .ask .tool,
  .ask .go {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 10px;
    border: 1px solid var(--rule);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }

  .add-source button:disabled,
  .source-head .tool:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .source-head .tool.accent,
  .ask .go {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .sources-tools {
    display: flex;
    justify-content: flex-end;
    margin: 0 0 6px;
  }

  .source {
    border-top: 1px solid var(--rule);
    padding: 8px 0 4px;
  }

  .source-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 4px;
  }

  .source-name {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .source-meta {
    flex: 1;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .plugin {
    align-items: flex-start;
  }

  .plugin-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .plugin-text .version {
    font-size: 10.5px;
    color: var(--ink-3);
    font-weight: 400;
  }

  .plugin-desc {
    font-size: 12px;
    color: var(--ink-2);
  }

  .plugin-meta {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .ask {
    margin: 0 0 8px;
    padding: 8px 10px;
    border: 1px solid var(--accent);
  }

  .ask p {
    margin: 0 0 8px;
    font-size: 12.5px;
    color: var(--ink);
  }

  .ask-actions {
    display: flex;
    gap: 6px;
  }
</style>

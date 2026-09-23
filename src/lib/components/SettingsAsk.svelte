<script lang="ts">
  import { coversBrowser } from "$lib/browser.svelte";
  import { DEFAULTS, type CustomTheme } from "$lib/customThemes";
  import {
    allowChange,
    declineChange,
    dismissUndo,
    settingsAsk,
    undoChange,
  } from "$lib/settingsTools.svelte";

  let ask = $derived(settingsAsk.asking);
  let undo = $derived(settingsAsk.undo);

  /** A colour of a theme being saved, the default palette's where it sets none. */
  function tone(shown: CustomTheme, appearance: "light" | "dark", token: string): string {
    return shown[appearance][token] ?? DEFAULTS[appearance][token];
  }
</script>

{#if ask !== null}
  <div
    class="ask"
    role="alertdialog"
    aria-label="Change the settings"
    use:coversBrowser
    data-testid="settings-ask"
  >
    <p class="title">{ask.caller} wants to change the settings</p>
    {#if ask.reason !== null}
      <p class="reason" data-testid="settings-ask-reason">{ask.reason}</p>
    {/if}
    <ul class="changes">
      {#each ask.changes as change (change.field)}
        <li data-testid="settings-ask-change" data-field={change.field}>
          <span class="name">{change.label}</span>
          <span class="from">{change.from}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="sr">to</span>
          <span class="to">{change.to}</span>
        </li>
      {/each}
    </ul>
    {#if ask.theme !== null}
      {@const shown = ask.theme}
      <div class="previews" data-testid="settings-ask-theme">
        {#each ["light", "dark"] as const as appearance (appearance)}
          <div
            class="preview"
            data-appearance={appearance}
            style:background={tone(shown, appearance, "bg")}
            style:border-radius={shown.shape.radius ?? "var(--radius)"}
          >
            <div
              class="card"
              style:background={tone(shown, appearance, "surface")}
              style:border-color={tone(shown, appearance, "rule")}
              style:border-radius={shown.shape["radius-sm"] ?? "var(--radius-sm)"}
            >
              <span class="bar" style:background={tone(shown, appearance, "accent")}></span>
              <span class="ink" style:color={tone(shown, appearance, "ink")}>{appearance === "light" ? "Light" : "Dark"}</span>
              <span class="ink-2" style:color={tone(shown, appearance, "ink-2")}>Aa</span>
              <span class="add" style:color={tone(shown, appearance, "add")}>+2</span>
              <span class="del" style:color={tone(shown, appearance, "del")}>−1</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button class="go" onclick={allowChange} data-testid="settings-allow">Allow</button>
      <button class="later" onclick={declineChange} data-testid="settings-decline">Decline</button>
    </div>
  </div>
{/if}

<!-- The two share a place: a question up hides the word until it is answered. -->
{#if undo !== null && ask === null}
  <div class="undo" role="status" use:coversBrowser data-testid="settings-undo">
    <span class="said">
      {undo.caller} changed {undo.changes.length === 1
        ? undo.changes[0].label.toLowerCase()
        : "the settings"}
    </span>
    <button class="go" onclick={undoChange} data-testid="settings-undo-button">Undo</button>
    <button
      class="close"
      onclick={dismissUndo}
      aria-label="Keep the change"
      data-testid="settings-undo-close">×</button
    >
  </div>
{/if}

<style>
  /* Over the agent pane, near the top, where the question is read before
     the terminal under it; the same place a session's start is asked. */
  .ask {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    width: min(440px, calc(100vw - 48px));
    padding: 10px 12px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
  }

  .title {
    margin: 0 0 4px;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--accent);
  }

  .reason {
    margin: 0 0 8px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .changes {
    margin: 0 0 10px;
    padding: 6px 8px;
    list-style: none;
    border-left: 2px solid var(--rule);
    background: var(--surface);
    font-size: 12.5px;
    line-height: 1.6;
  }

  .changes li {
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex-wrap: wrap;
  }

  .name {
    color: var(--ink-2);
    margin-right: 2px;
  }

  .from {
    color: var(--ink-3);
    text-decoration: line-through;
  }

  .arrow {
    color: var(--ink-3);
  }

  .to {
    color: var(--ink);
    font-weight: 600;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  /* The theme as it would paint, one small card on its ground for each
     appearance. */
  .previews {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 0 0 10px;
  }

  .preview {
    padding: 8px;
    border: 1px solid var(--rule);
  }

  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid;
    font-size: 12px;
  }

  .bar {
    width: 3px;
    height: 14px;
    border-radius: 1px;
  }

  .ink {
    font-weight: 600;
  }

  button {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    border-radius: var(--radius);
    padding: 4px 12px;
    cursor: pointer;
  }

  .go {
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .later {
    border: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
  }

  .later:hover {
    color: var(--ink);
  }

  /* Where the question was, clear of the agent's prompt at the foot of its
     pane, for as long as the change can be undone. */
  .undo {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: calc(100vw - 48px);
    padding: 6px 8px 6px 12px;
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
    font-size: 12.5px;
  }

  .said {
    overflow-wrap: anywhere;
  }

  .undo .go {
    padding: 2px 10px;
  }

  .close {
    border: none;
    background: none;
    padding: 0 4px;
    color: var(--ink-3);
    font-size: 15px;
    line-height: 1;
  }

  .close:hover {
    color: var(--ink);
  }
</style>

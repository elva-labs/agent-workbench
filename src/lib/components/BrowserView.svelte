<script lang="ts">
  import { onMount } from "svelte";
  import type { BrowserTab } from "$lib/core";
  import {
    activate,
    activeTab,
    back,
    browser,
    close,
    forward,
    hide,
    home,
    navigate,
    open,
    place,
    reload,
    type Rect,
  } from "$lib/browser.svelte";

  let tab = $derived(activeTab());
  /** A new tab, with nothing to place the native view over: the placeholder
      draws the app's own page instead. */
  let isNewTab = $derived(tab === null || tab.url === "about:blank");
  /** A page that did not load: the body says so itself, since what the
      native view holds then is a blank page. */
  let failed = $derived(!isNewTab && tab !== null && tab.error !== null);
  let errorText = $derived(browser.addressError ?? tab?.error ?? null);

  /** The address field's own text, separate from the tab's url so typing
      is not overwritten mid-edit by a url the tab already has. */
  let draft = $state("");
  let editing = $state(false);
  let addressInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    const current = activeTab();
    if (editing) return;
    draft = current === null || current.url === "about:blank" ? "" : current.url;
  });

  function onAddressFocus(e: FocusEvent) {
    editing = true;
    (e.currentTarget as HTMLInputElement).select();
  }

  function onAddressBlur() {
    editing = false;
  }

  function onAddressKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      // An address that was taken gives the keyboard to the page, and the
      // field shows where the tab went; one that was refused stays to be
      // corrected.
      void navigate(draft).then(() => {
        if (browser.addressError === null) addressInput?.blur();
      });
    } else if (e.key === "Escape") {
      e.stopPropagation();
      const current = activeTab();
      draft = current === null || current.url === "about:blank" ? "" : current.url;
      addressInput?.blur();
    }
  }

  function titleFor(candidate: BrowserTab): string {
    if (candidate.title !== "") return candidate.title;
    if (candidate.url === "about:blank" || candidate.url === "") return "New tab";
    try {
      return new URL(candidate.url).host || candidate.url;
    } catch {
      return candidate.url;
    }
  }

  function newTab() {
    void open();
  }

  // A new tab draws its own page in the body and takes the keyboard, the
  // way opening a file lands it in the viewer.
  $effect(() => {
    if (isNewTab) addressInput?.focus();
  });

  /*
   * The placeholder the native view sits over. Its rectangle is kept in
   * step with `place`: on mount, on a resize of the placeholder or the
   * window, and every animation frame while the rectangle is still
   * changing, since a column eases its width with no resize event of its
   * own. The frame loop stops once the rectangle has stood still for a few
   * frames, and starts again on the next signal that it might have moved.
   */
  let bodyEl: HTMLDivElement | undefined = $state();
  let previous: Rect | null = null;
  let stillFor = 0;
  let rafHandle: number | null = null;
  const STILL_FRAMES = 4;

  function sameRect(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function measure() {
    if (!bodyEl) return;
    const box = bodyEl.getBoundingClientRect();
    const rect: Rect = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    place(rect);
    stillFor = previous !== null && sameRect(rect, previous) ? stillFor + 1 : 0;
    previous = rect;
  }

  function loop() {
    measure();
    rafHandle = stillFor < STILL_FRAMES ? requestAnimationFrame(loop) : null;
  }

  /** Restarts the frame loop, unless it is already running. */
  function nudge() {
    stillFor = 0;
    if (rafHandle === null) rafHandle = requestAnimationFrame(loop);
  }

  onMount(() => {
    const observer = new ResizeObserver(nudge);
    if (bodyEl) observer.observe(bodyEl);
    window.addEventListener("resize", nudge);
    nudge();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", nudge);
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      hide();
    };
  });

  // The active tab, or whether the viewer is showing the browser at all,
  // can change without the placeholder's own size changing: a tab switch
  // from a new tab to a real page still needs the native view placed.
  $effect(() => {
    activeTab();
    browser.showing;
    nudge();
  });
</script>

<div class="viewer" data-testid="viewer" data-view="browser">
<div class="bar" data-testid="browser-header">
  <button
    class="icon"
    aria-label="Back"
    disabled={tab === null || !tab.canGoBack}
    onclick={() => void back()}
    data-testid="browser-back">‹</button
  >
  <button
    class="icon"
    aria-label="Forward"
    disabled={tab === null || !tab.canGoForward}
    onclick={() => void forward()}
    data-testid="browser-forward">›</button
  >
  <button
    class="icon"
    aria-label="Reload"
    disabled={tab === null}
    onclick={() => void reload()}
    data-testid="browser-reload">⟳</button
  >
  <button
    class="icon"
    aria-label="Home"
    disabled={tab === null}
    onclick={() => void home()}
    data-testid="browser-home">⌂</button
  >
  <label class="field">
    <input
      type="text"
      bind:this={addressInput}
      value={draft}
      oninput={(e) => (draft = (e.currentTarget as HTMLInputElement).value)}
      onfocus={onAddressFocus}
      onblur={onAddressBlur}
      onkeydown={onAddressKeydown}
      placeholder="Enter an address"
      spellcheck="false"
      autocomplete="off"
      aria-label="Address"
      data-testid="browser-address"
    />
    {#if tab?.loading}
      <span class="loading" aria-hidden="true" data-testid="browser-loading">loading…</span>
    {/if}
  </label>
</div>
{#if errorText !== null}
  <p class="notice error" data-testid="browser-error">{errorText}</p>
{/if}

<div class="tabs" role="tablist" aria-label="Browser tabs" data-testid="browser-tabs">
  {#each browser.tabs as candidate (candidate.id)}
    <div class="tab" class:active={candidate.id === browser.active} data-testid="browser-tab" data-tab-id={candidate.id}>
      <button
        class="select"
        role="tab"
        aria-selected={candidate.id === browser.active}
        title={titleFor(candidate)}
        onclick={() => void activate(candidate.id)}
        data-testid="browser-tab-select"
      >
        {#if candidate.opener.kind === "agent"}
          <span class="agent-mark" title="Opened by an agent" data-testid="browser-tab-agent"></span>
        {/if}
        <span class="title">{titleFor(candidate)}</span>
      </button>
      <button
        class="tab-close"
        aria-label="Close tab"
        onclick={() => void close(candidate.id)}
        data-testid="browser-tab-close">×</button
      >
    </div>
  {/each}
  <button class="new-tab" aria-label="New tab" onclick={newTab} data-testid="browser-new-tab">+</button>
</div>

<div class="body" bind:this={bodyEl} data-testid="browser-body">
  {#if isNewTab}
    <div class="placeholder">
      <p class="line">New tab</p>
      <p class="hint">Type an address above to get started.</p>
      {#if browser.tabs.length === 0}
        <button class="start" onclick={newTab} data-testid="browser-open-tab">New tab</button>
      {/if}
    </div>
  {:else if failed}
    <div class="placeholder" data-testid="browser-failed">
      <p class="line">This page did not load</p>
      <p class="hint">{tab?.error}</p>
      <button class="start" onclick={() => void reload()} data-testid="browser-retry">Try again</button>
    </div>
  {/if}
</div>
</div>

<style>
  .viewer {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    background: var(--surface);
  }

  .icon {
    flex: none;
    font-family: var(--chrome);
    font-size: 14px;
    line-height: 1;
    padding: 3px 7px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }

  .icon:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }

  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field-bg);
  }

  .field:focus-within {
    border-color: var(--accent);
  }

  .field input {
    flex: 1;
    min-width: 0;
    padding: 4px 0;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
    outline: none;
  }

  .field input::placeholder {
    color: var(--ink-3);
  }

  .loading {
    flex: none;
    font-size: 11px;
    color: var(--ink-3);
  }

  .notice {
    margin: 0;
    padding: 8px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-3);
  }

  .notice.error {
    color: var(--del);
  }

  .tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--head-rule);
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--surface-2);
  }

  .tab {
    flex: none;
    display: flex;
    align-items: center;
    max-width: 180px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--ink-3);
  }

  .tab.active {
    background: var(--surface);
    border-color: var(--rule);
    color: var(--ink);
  }

  .select {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    padding: 4px 4px 4px 8px;
    border: 0;
    background: none;
    color: inherit;
    font-family: var(--chrome);
    font-size: 11.5px;
    cursor: pointer;
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-mark {
    flex: none;
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    background: var(--accent);
  }

  .tab-close {
    flex: none;
    padding: 2px 7px 2px 2px;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .tab-close:hover {
    color: var(--del);
  }

  .new-tab {
    flex: none;
    align-self: center;
    padding: 3px 9px;
    margin-left: 2px;
    border: 1px dashed var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-3);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .new-tab:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .body {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
  }

  .line {
    margin: 0;
    font-size: 13px;
    color: var(--ink-2);
  }

  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
  }

  .start {
    margin-top: 6px;
    padding: 5px 14px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-2);
    font-family: var(--chrome);
    font-size: 12px;
    cursor: pointer;
  }

  .start:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>

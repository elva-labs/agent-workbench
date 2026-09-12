<script lang="ts">
  import { onMount } from "svelte";
  import { returnFocus } from "$lib/layout.svelte";
  import { browse, choose, closeRemote, connect, pair, parentOf, pathOn, remote } from "$lib/remote.svelte";

  /**
   * Reaching a machine. Over the workbench like the settings, and closed the
   * same ways. A token pasted from the machine, or the name of a host the
   * user's ssh already reaches; then the machine's folders.
   */

  let dialog: HTMLDivElement;
  let tokenField = $state<HTMLTextAreaElement | null>(null);

  // The keyboard is taken on the way in and handed back on the way out,
  // whichever way the dialog closed.
  onMount(() => {
    dialog.focus();
    tokenField?.focus();
    return returnFocus;
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeRemote();
    }
  }

  /** A button that goes busy drops the keyboard on the way, so Escape may
      arrive at the window rather than the dialog. It still closes. */
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !dialog.contains(e.target as Node)) closeRemote();
  }

  /** Every name worth suggesting: the configuration's hosts and the paired
      machines, once each. */
  let suggestions = $derived(
    Array.from(
      new Set([...remote.hosts.configured, ...remote.hosts.saved.map((saved) => saved.target)]),
    ),
  );

  let up = $derived(remote.listing === null ? null : parentOf(remote.listing.path));
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={closeRemote} data-testid="remote-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="remote-title"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="remote"
  >
    <header>
      <h2 id="remote-title">
        {#if remote.step === "browse" && remote.target !== null}
          On {remote.target}
        {:else}
          Remote
        {/if}
      </h2>
      <button class="tool" onclick={closeRemote} data-testid="remote-close">Esc</button>
    </header>

    <div class="body">
      {#if remote.step === "connect"}
        <p class="note">
          On the machine, run <code>agent-workbench-remote connect</code> and paste what it
          prints. It brings the key, the address and the user with it.
        </p>
        <form
          class="fields"
          onsubmit={(e) => {
            e.preventDefault();
            pair();
          }}
        >
          <textarea
            bind:this={tokenField}
            bind:value={remote.token}
            rows="3"
            placeholder="awb1.…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Token"
            data-testid="remote-token"
          ></textarea>
          <div class="actions">
            <button class="primary" type="submit" disabled={remote.busy} data-testid="remote-pair">
              {remote.busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
        <p class="note quiet">Or a host your ssh already reaches, as you would name it there.</p>
        <form
          class="fields"
          onsubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <label>
            <span>Host</span>
            <input
              bind:value={remote.host}
              list="remote-hosts"
              placeholder="name, or user@name"
              autocomplete="off"
              spellcheck="false"
              data-testid="remote-host"
            />
            <datalist id="remote-hosts">
              {#each suggestions as name (name)}
                <option value={name}></option>
              {/each}
            </datalist>
          </label>
          <div class="actions">
            <button class="primary" type="submit" disabled={remote.busy} data-testid="remote-connect">
              {remote.busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      {:else if remote.listing !== null}
        <p class="path" data-testid="remote-path">{pathOn(remote.listing.path)}</p>
        <div class="dirs">
          {#if up !== null}
            <button class="dir up" onclick={() => browse(up!)} disabled={remote.busy} data-testid="remote-up">
              ..
            </button>
          {/if}
          {#each remote.listing.dirs as dir (dir.path)}
            <button class="dir" onclick={() => browse(dir.path)} disabled={remote.busy} data-testid="remote-dir">
              {dir.name}
            </button>
          {:else}
            <p class="note quiet">No folders in here.</p>
          {/each}
        </div>
        <div class="actions">
          <button
            class="primary"
            onclick={() => choose(remote.listing!.path)}
            disabled={remote.busy}
            data-testid="remote-open"
          >
            Open this folder
          </button>
        </div>
      {/if}

      {#if remote.error !== null}
        <p class="error" data-testid="remote-error">{remote.error}</p>
      {/if}
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
    width: min(520px, calc(100vw - 48px));
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    outline: none;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  h2 {
    margin: 0;
    font-family: var(--chrome);
    font-size: var(--title-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: 500;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    overflow-y: auto;
    padding: 10px var(--pane-pad) 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .note {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .note.quiet {
    color: var(--ink-3);
  }


  .fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    display: grid;
    grid-template-columns: 8ch 1fr;
    align-items: center;
    gap: 8px;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  .note code {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.4;
    padding: 6px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--ink);
    outline: none;
    word-break: break-all;
  }

  textarea:focus {
    border-color: var(--accent);
  }

  input {
    font-family: var(--chrome);
    font-size: 12.5px;
    padding: 5px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--ink);
    outline: none;
  }

  input:focus {
    border-color: var(--accent);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .primary {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }

  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .tool {
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tool:hover {
    color: var(--accent);
  }

  .path {
    margin: 0;
    font-family: var(--chrome);
    font-size: 11.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dirs {
    display: flex;
    flex-direction: column;
    max-height: 40vh;
    overflow-y: auto;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
  }

  .dir {
    text-align: left;
    padding: 4px 10px;
    border: 0;
    border-bottom: 1px solid var(--rule);
    background: none;
    font-family: var(--chrome);
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .dir:last-child {
    border-bottom: 0;
  }

  .dir:hover:not(:disabled) {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .dir.up {
    color: var(--ink-3);
  }

  .error {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--del);
  }
</style>

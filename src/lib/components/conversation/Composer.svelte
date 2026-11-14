<script lang="ts">
  import { tick, untrack } from "svelte";
  import { core, type IntegratedImage } from "$lib/core";
  import type { Conversation } from "$lib/conversation.svelte";
  import { register, unregister } from "$lib/drops.svelte";
  import { configure, interrupt, linkFor, send } from "$lib/integrated.svelte";
  import { layout, overlayHoldsKeyboard } from "$lib/layout.svelte";
  import { tokens } from "$lib/thread";
  import Icon from "./Icon.svelte";

  /**
   * Where the user writes to the agent. It takes several lines, files and
   * images dropped, pasted or picked, shows the model the session runs on
   * and lets it be changed, and turns Send into Stop while the agent works.
   * A message sent meanwhile waits for the turn, and the thread says so.
   *
   * Enter sends and Shift+Enter breaks the line. Escape stops a running
   * turn; with none running it is the app's. Up from an empty composer
   * reaches what the agent waits on, when it waits on something.
   */
  interface Props {
    sessionKey: string;
    conversation: Conversation;
    /** The agent's name, for the placeholder. */
    agent: string;
    /** Whether the session can take a message now. */
    ready: boolean;
    /** Whether the session is the one on screen in the pane. */
    active: boolean;
    /** Puts the keyboard on the dock, when something waits there. */
    onDock?: () => boolean;
  }

  let { sessionKey, conversation, agent, ready, active, onDock }: Props = $props();

  let link = $derived(linkFor(sessionKey));
  let field = $state<HTMLTextAreaElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  let menu = $state(false);
  let reading = $state(0);

  let running = $derived(conversation.current !== null || conversation.working);
  let hasWords = $derived(link.draft.trim() !== "" || link.images.length > 0);

  /** The kinds of image the agent takes. */
  const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

  function submit() {
    if (!ready || !hasWords) return;
    const id = send(sessionKey, link.draft, link.images);
    if (id === null) return;
    link.draft = "";
    link.images = [];
    void tick().then(grow);
  }

  function stop() {
    interrupt(sessionKey);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && !e.isComposing) {
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        menu = false;
      } else if (running) {
        e.preventDefault();
        e.stopPropagation();
        stop();
      }
    } else if (e.key === "ArrowUp" && link.draft === "" && onDock?.()) {
      e.preventDefault();
    }
  }

  /** The field grows with what is written, up to a share of the pane. */
  function grow() {
    if (field === null) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }

  $effect(() => {
    void link.draft;
    untrack(grow);
  });

  async function attach(files: File[]) {
    for (const file of files) {
      if (!IMAGES.includes(file.type)) continue;
      reading += 1;
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        link.images = [...link.images, { mediaType: file.type, data }];
      } catch {
        // An image that cannot be read is left out.
      } finally {
        reading -= 1;
      }
    }
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((file) => IMAGES.includes(file.type));
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  }

  /** Files dropped on the conversation: an image goes with the message,
      anything else by its path in the text. */
  async function take(paths: string[]) {
    const words: string[] = [];
    for (const path of paths) {
      if (!IMAGE_FILE.test(path)) {
        words.push(path);
        continue;
      }
      reading += 1;
      try {
        const found = await core().readMedia(path);
        if (IMAGES.includes(found.mime)) link.images = [...link.images, { mediaType: found.mime, data: found.data }];
        else words.push(path);
      } catch {
        words.push(path);
      } finally {
        reading -= 1;
      }
    }
    if (words.length > 0) insert(words.join(" "));
  }

  function insert(text: string) {
    const at = field?.selectionStart ?? link.draft.length;
    const end = field?.selectionEnd ?? at;
    const before = link.draft.slice(0, at);
    const space = before === "" || /\s$/.test(before) ? "" : " ";
    link.draft = `${before}${space}${text} ${link.draft.slice(end)}`;
  }

  function remove(image: IntegratedImage) {
    link.images = link.images.filter((known) => known !== image);
  }

  $effect(() => {
    if (box === null) return;
    const key = sessionKey;
    register(key, box, {
      paste: (text) => insert(text),
      focus: () => field?.focus(),
      take: (paths) => void take(paths),
    });
    return () => unregister(key);
  });

  // Focusing the agent pane puts the keyboard here, unless another control
  // of the pane has it, the dock most of all, or a dialog holds it.
  $effect(() => {
    layout.focusRequest;
    const focused = layout.focus === "agent";
    if (!focused || !active || field === null) return;
    untrack(() => {
      if (overlayHoldsKeyboard()) return;
      const owner = document.activeElement;
      const pane = field!.closest("section[data-pane]");
      if (owner !== null && owner !== document.body && owner !== field && pane?.contains(owner)) return;
      field!.focus();
    });
  });

  // ---- the model ----

  let models = $derived(conversation.ready?.models ?? []);
  let current = $derived(conversation.settings.model);
  let modelName = $derived.by(() => {
    const value = current ?? "default";
    const offered = models.find((model) => model.value === value);
    const name = offered?.name ?? current ?? "Default model";
    return name.charAt(0).toUpperCase() + name.slice(1);
  });

  function chooseModel(value: string) {
    menu = false;
    if (value !== current) void configure(sessionKey, { model: value });
    field?.focus();
  }

  function onMenuKey(e: KeyboardEvent) {
    const items = [...((e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"))];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      menu = false;
      void tick().then(() => box?.querySelector<HTMLButtonElement>("[data-testid='model-chip']")?.focus());
    }
  }

  function openMenu() {
    menu = !menu;
    if (menu)
      void tick().then(() =>
        (box?.querySelector<HTMLButtonElement>("[aria-checked='true']") ??
          box?.querySelector<HTMLButtonElement>("[role='menuitemradio']"))?.focus(),
      );
  }

  let context = $derived.by(() => {
    const used = conversation.context?.used ?? null;
    const size = conversation.context?.size ?? null;
    if (used === null) return null;
    if (size === null || size === 0) return { text: `${tokens(used)} tokens`, title: `${used} tokens of context` };
    const share = Math.round((used / size) * 100);
    return { text: `${share}% of context`, title: `${tokens(used)} of ${tokens(size)} tokens` };
  });
</script>

<div class="composer" bind:this={box} data-drop={sessionKey} data-testid="composer">
  {#if link.images.length > 0 || reading > 0}
    <div class="attached" data-testid="attachments">
      {#each link.images as image, at (at)}
        <span class="thumb">
          <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          <button class="remove" onclick={() => remove(image)} aria-label="Remove image {at + 1}" data-testid="remove-attachment"
            ><Icon name="x" size={10} /></button
          >
        </span>
      {/each}
      {#if reading > 0}<span class="reading">Reading…</span>{/if}
    </div>
  {/if}
  <textarea
    bind:this={field}
    bind:value={link.draft}
    {onkeydown}
    {onpaste}
    rows="1"
    placeholder={conversation.entries.length === 0 ? `Tell ${agent} what to do` : `Reply to ${agent}`}
    aria-label="Message to {agent}"
    data-testid="composer-input"
  ></textarea>
  <div class="bar">
    <button class="chip bare" onclick={() => picker?.click()} aria-label="Attach images" title="Attach images" data-testid="attach"
      ><Icon name="clip" /></button
    >
    <input
      bind:this={picker}
      type="file"
      accept={IMAGES.join(",")}
      multiple
      hidden
      onchange={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        void attach([...(input.files ?? [])]);
        input.value = "";
      }}
    />
    <div class="model">
      <button
        class="chip"
        onclick={openMenu}
        disabled={models.length === 0 || !ready}
        aria-haspopup="menu"
        aria-expanded={menu}
        title="The model the session runs on"
        data-testid="model-chip">{modelName}<Icon name="down" size={12} /></button
      >
      {#if menu}
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div class="menu" role="menu" aria-label="Model" onkeydown={onMenuKey} data-testid="model-menu">
          {#each models as model (model.value)}
            {@const on = model.value === (current ?? "default")}
            <button role="menuitemradio" aria-checked={on} class:on onclick={() => chooseModel(model.value)} data-testid="model-option">
              <span class="name">{model.name ?? model.value}</span>
              {#if model.description}<span class="about">{model.description}</span>{/if}
              {#if on}<span class="tick"><Icon name="check" size={12} /></span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    {#if link.configureError !== null}
      <span class="error" title={link.configureError}>The model was not changed: {link.configureError}</span>
    {/if}
    <span class="ctx" title={context?.title}>{context?.text ?? ""}</span>
    {#if running}
      <button class="round stop" onclick={stop} aria-label="Stop" title="Stop the agent (Esc)" data-testid="stop"
        ><Icon name="stop" size={12} /></button
      >
    {/if}
    {#if !running || hasWords}
      <button
        class="round send"
        onclick={submit}
        disabled={!ready || !hasWords}
        aria-label={running ? "Send, to wait for the agent" : "Send"}
        title={running ? "Send; it waits until the agent is done (Enter)" : "Send (Enter)"}
        data-testid="send"><Icon name="up" size={14} /></button
      >
    {/if}
  </div>
</div>

<style>
  .composer {
    max-width: 740px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px 12px 9px;
    border-radius: calc(var(--radius) * 2);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
  }

  .composer:focus-within {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, var(--divider, var(--rule)));
  }

  :global([data-drop].target) .composer,
  .composer:global(.target) {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  textarea {
    width: 100%;
    min-height: 22px;
    max-height: 38vh;
    padding: 0 2px;
    border: 0;
    outline: none;
    resize: none;
    background: none;
    font: inherit;
    font-size: var(--conv-size);
    line-height: 1.5;
    color: var(--ink);
    overflow-y: auto;
  }

  textarea::placeholder {
    color: var(--ink-3);
  }

  .attached {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .thumb {
    position: relative;
    display: block;
  }

  .thumb img {
    display: block;
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .remove {
    position: absolute;
    top: -6px;
    right: -6px;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
    color: var(--surface);
    cursor: pointer;
  }

  .reading {
    font-size: 12px;
    color: var(--ink-3);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 999px;
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font: inherit;
    font-size: 12px;
    color: var(--ink-2);
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:hover:not(:disabled) {
    color: var(--ink);
    background: var(--surface);
  }

  .chip:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .chip.bare {
    box-shadow: none;
    padding: 0 6px;
    color: var(--ink-3);
  }

  .model {
    position: relative;
    min-width: 0;
  }

  .menu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    min-width: 220px;
    max-width: 320px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
  }

  .menu button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 16px;
    align-items: center;
    column-gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: 12.5px;
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }

  .menu button:hover,
  .menu button:focus-visible {
    background: var(--accent-soft);
    color: var(--ink);
    outline: none;
  }

  .menu .on {
    color: var(--ink);
  }

  .name {
    grid-column: 1;
  }

  .about {
    grid-column: 1;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .tick {
    grid-column: 2;
    grid-row: 1;
    color: var(--accent);
  }

  .error {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--del);
  }

  .ctx {
    margin-left: auto;
    padding-right: 4px;
    font-size: 12px;
    color: var(--ink-3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .round {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
  }

  .send {
    background: var(--accent);
    color: var(--bg);
  }

  .send:disabled {
    background: var(--rule-strong);
    color: var(--surface);
    cursor: default;
  }

  .stop {
    background: var(--ink);
    color: var(--surface);
  }
</style>

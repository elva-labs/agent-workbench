<script lang="ts">
  import { tick, untrack } from "svelte";
  import { core, type IntegratedImage } from "$lib/core";
  import type { Conversation } from "$lib/conversation.svelte";
  import { register, unregister } from "$lib/drops.svelte";
  import { compact, interrupt, linkFor, send } from "$lib/integrated.svelte";
  import { layout, overlayHoldsKeyboard } from "$lib/layout.svelte";
  import { choose, modeChoices, modelChoices } from "$lib/settingChoices";
  import { modelName, tokens } from "$lib/thread";
  import { pieces } from "$lib/completion";
  import { complete, named, slashGroups, slashWord, sourceOf, waitingHint } from "$lib/slash";
  import ChoiceMenu from "../ChoiceMenu.svelte";
  import CompletionMenu, { rowId } from "./CompletionMenu.svelte";
  import Icon from "./Icon.svelte";
  import Plain from "./Plain.svelte";
  import { shown } from "$lib/unseen";

  /**
   * Where the user writes to the agent. It takes several lines, files and
   * images dropped, pasted or picked, shows the model the session runs on
   * and lets it be changed, and turns Send into Stop while the agent works.
   * A message sent meanwhile waits for the turn, and the thread says so.
   *
   * Enter sends and Shift+Enter breaks the line. Escape stops a running
   * turn; with none running it is the app's. Up from an empty composer
   * reaches what the agent waits on, when it waits on something.
   *
   * A slash typed as the first thing in a message opens the agent's
   * commands and skills over the composer, for an agent that lists them:
   * typing narrows them, the arrows mark one, and Tab or Enter puts it in
   * the field, its argument hint waiting after it until something is
   * typed. Escape puts the menu away and stops nothing. A message that is
   * the compact command compacts through the agent's own compaction.
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
    /** Whether the session runs on the agent's default model, the user
        having chosen none. */
    defaultModel?: boolean;
    /** Whether the agent lists slash commands once ready. */
    slash?: boolean;
  }

  let { sessionKey, conversation, agent, ready, active, onDock, defaultModel = false, slash = false }: Props =
    $props();

  let link = $derived(linkFor(sessionKey));
  let field = $state<HTMLTextAreaElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  /** The menu open over the composer's bar, if one is. */
  let menu = $state<"model" | "mode" | null>(null);
  /** It was opened with the pointer rather than a key. */
  let byPointer = $state(false);
  let reading = $state(0);

  // ---- slash commands ----

  /** Where the caret is in the field, as last seen. */
  let caret = $state(0);
  let focused = $state(false);
  /** The message as it stood when Escape put the menu away: the menu stays
      away until the message changes. */
  let dismissed = $state<string | null>(null);
  /** The row marked by a key or the pointer, for the word it was marked in;
      a new word marks its best match. */
  let marked = $state({ query: "", index: 0 });

  let commands = $derived(conversation.ready?.commands ?? []);
  let word = $derived(slash && focused && dismissed !== link.draft ? slashWord(link.draft, caret) : null);
  let groups = $derived(word === null || conversation.ready === null ? [] : slashGroups(commands, word.query));
  let matches = $derived(groups.flatMap((group) => group.matches));
  /** What the menu shows, when it is open: the agent's list, a word that
      nothing matches, or the agent not ready to list anything yet. */
  let slashMenu = $derived<"list" | "none" | "starting" | null>(
    word === null
      ? null
      : conversation.ready === null
        ? "starting"
        : matches.length > 0
          ? "list"
          : commands.length > 0
            ? "none"
            : null,
  );
  let marking = $derived(
    word !== null && marked.query === word.query ? Math.min(marked.index, Math.max(0, matches.length - 1)) : 0,
  );
  /** The argument hint after a command just put in the field. */
  let ghost = $derived(slash && slashMenu === null ? waitingHint(link.draft, commands) : null);
  let menuId = $derived(`slash-${sessionKey.replace(/[^\w-]/g, "_")}`);

  function seen() {
    if (field !== null) caret = field.selectionStart;
  }

  function mark(index: number) {
    marked = { query: word?.query ?? "", index };
  }

  /** Puts the command at that place in the menu in the field, a space
      after it, with the caret there. */
  function completeAt(index: number) {
    const command = matches[index]?.item;
    if (command === undefined || word === null) return;
    const done = complete(link.draft, word, command.name);
    link.draft = done.text;
    caret = done.caret;
    void tick().then(() => {
      field?.focus();
      field?.setSelectionRange(done.caret, done.caret);
    });
  }

  /** The keys the menu takes while it is open; true when one was taken. */
  function menuKey(e: KeyboardEvent): boolean {
    if (slashMenu === null || e.isComposing || e.keyCode === 229) return false;
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissed = link.draft;
      return true;
    }
    if (slashMenu !== "list" || !plain) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      mark((marking + step + matches.length) % matches.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      completeAt(marking);
      return true;
    }
    return false;
  }

  let running = $derived(conversation.current !== null || conversation.working);
  let hasWords = $derived(link.draft.trim() !== "" || link.images.length > 0);

  /** The kinds of image the agent takes. */
  const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

  /** A send asked for while images were still being read, made once they
      are, so no image goes with the wrong message. */
  let held = $state(false);
  /** A lone digit was about to go as a message while the agent waits on an
      answer: said, and sent only on a second Enter. */
  let digit = $state<string | null>(null);

  $effect(() => {
    if (reading === 0 && held) {
      held = false;
      untrack(submit);
    }
  });

  $effect(() => {
    // The words changed: a warning about the last ones no longer holds.
    if (digit !== null && link.draft.trim() !== digit) digit = null;
  });

  function submit() {
    if (!ready || !hasWords) return;
    if (reading > 0) {
      held = true;
      return;
    }
    const lone = link.draft.trim();
    if (conversation.open.length > 0 && link.images.length === 0 && /^[0-9]$/.test(lone) && digit !== lone) {
      digit = lone;
      return;
    }
    digit = null;
    const asked = slash && link.images.length === 0 ? named(link.draft, commands) : null;
    if (asked?.command.name === "compact") {
      if (compact(sessionKey, asked.rest)) {
        link.draft = "";
        void tick().then(grow);
      }
      return;
    }
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
    if (menuKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && !e.isComposing) {
      if (menu !== null) {
        e.preventDefault();
        e.stopPropagation();
        menu = null;
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

  // Focusing the agent pane, or this session coming on screen in it, puts
  // the keyboard here, unless another control of this same session has it
  // or a dialog holds it. A control of a session now hidden does not count.
  $effect(() => {
    layout.focusRequest;
    const focused = layout.focus === "agent";
    if (!focused || !active || field === null) return;
    untrack(() => {
      if (overlayHoldsKeyboard()) return;
      const owner = document.activeElement;
      const own = field!.closest("[data-session]");
      if (owner !== null && owner !== document.body && owner !== field && own?.contains(owner)) return;
      field!.focus();
    });
  });

  // A session going off screen lets the keyboard go, so nothing typed
  // lands in it unseen.
  $effect(() => {
    if (active || field === null) return;
    untrack(() => {
      const own = field!.closest("[data-session]");
      const owner = document.activeElement as HTMLElement | null;
      if (owner !== null && own?.contains(owner)) owner.blur();
    });
  });

  // ---- the model and the mode ----

  let models = $derived(conversation.ready?.models ?? []);
  let current = $derived(conversation.settings.model);
  let name = $derived(modelName(conversation, current));
  /** The model as the chip says it: which one a default is, once known. */
  let modelLabel = $derived(name === null ? "Default model" : defaultModel ? `Default · ${name}` : name);
  /** A model chosen during a turn, which the next turn runs on. */
  let after = $derived(conversation.modelAfterTurn);

  let modes = $derived(conversation.ready?.modes ?? []);
  let mode = $derived(conversation.settings.mode);
  let modeLabel = $derived(modes.find((known) => known.value === mode)?.name ?? mode ?? "Mode");

  function pick(setting: "model" | "mode", value: string) {
    menu = null;
    choose(sessionKey, conversation, setting, value);
    field?.focus();
  }

  function closeMenu(how: "escape" | "tab" | "away") {
    const which = menu;
    menu = null;
    if (how === "escape")
      void tick().then(() => box?.querySelector<HTMLButtonElement>(`[data-testid='${which}-chip']`)?.focus());
  }

  function openMenu(which: "model" | "mode", e: MouseEvent) {
    byPointer = e.detail > 0;
    menu = menu === which ? null : which;
  }

  // A press anywhere outside the open menu and its chip puts it away.
  $effect(() => {
    if (menu === null) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".picker") === null || target === null) menu = null;
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });

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
  {#if slashMenu !== null}
    <CompletionMenu
      id={menuId}
      label="Commands and skills"
      groups={groups.map((group) => ({ label: group.label, items: group.matches }))}
      active={marking}
      key={(match) => match.item.name}
      action="complete"
      onpick={completeAt}
      onpoint={mark}
      testid="slash-menu"
    >
      {#snippet row(match)}
        <span class="cmd-name" data-testid="slash-name"
          >/{#each pieces(match.item.name, match.marks) as piece, at (at)}{#if piece.hit}<b><Plain text={piece.text} /></b
              >{:else}<Plain text={piece.text} />{/if}{/each}{#if match.item.hint !== null}<span class="cmd-hint"
              ><Plain text={match.item.hint} /></span
            >{/if}</span
        >
        <span class="cmd-about"><Plain text={match.item.description ?? ""} /></span>
        <span class="cmd-source"><Plain text={sourceOf(match.item)} /></span>
      {/snippet}
      {#snippet empty()}
        {#if slashMenu === "starting"}
          {agent} is still starting. Its commands show here once it is ready.
        {:else}
          No command or skill is called <code><Plain text={link.draft.slice(0, word?.end ?? 0)} /></code>.
          <kbd>↵</kbd> sends it as a message.
        {/if}
      {/snippet}
    </CompletionMenu>
  {/if}
  {#if link.images.length > 0 || reading > 0}
    <div class="attached" data-testid="attachments">
      {#each link.images as image, at (at)}
        <span class="thumb">
          <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          <button class="remove" tabindex="0" onclick={() => remove(image)} aria-label="Remove image {at + 1}" data-testid="remove-attachment"
            ><Icon name="x" size={10} /></button
          >
        </span>
      {/each}
      {#if reading > 0}<span class="reading">Reading…</span>{/if}
    </div>
  {/if}
  <div class="write">
    <textarea
      bind:this={field}
      bind:value={link.draft}
      {onkeydown}
      {onpaste}
      oninput={seen}
      onkeyup={seen}
      onpointerup={seen}
      onselect={seen}
      onfocus={() => {
        focused = true;
        seen();
      }}
      onblur={() => (focused = false)}
      rows="1"
      placeholder={conversation.open.length > 0
        ? "↑ to answer, or write a message"
        : conversation.entries.length === 0
          ? `Tell ${agent} what to do`
          : `Reply to ${agent}`}
      aria-label="Message to {agent}"
      aria-autocomplete={slash ? "list" : undefined}
      aria-controls={slashMenu === "list" ? menuId : undefined}
      aria-activedescendant={slashMenu === "list" ? rowId(menuId, marking) : undefined}
      data-testid="composer-input"
    ></textarea>
    {#if ghost !== null}
      <div class="ghost" aria-hidden="true" data-testid="slash-hint">
        <span class="typed">{link.draft}</span><Plain text={ghost} />
      </div>
    {/if}
  </div>
  {#if digit !== null}
    <p class="hint" data-testid="composer-digit">
      “{digit}” would go to {agent} as a message, not as an answer. Press ↑ to answer, or Enter again to send it.
    </p>
  {:else if held}
    <p class="hint" data-testid="composer-held">Sends once the images are read.</p>
  {:else if link.compactAsked && running && !conversation.compacting}
    <p class="hint" data-testid="composer-compact">Compacts once {agent} is done with this turn.</p>
  {/if}
  <div class="bar">
    <button class="chip bare" tabindex="0" onclick={() => picker?.click()} aria-label="Attach images" title="Attach images" data-testid="attach"
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
    <div class="picker">
      <button
        class="chip"
        tabindex="0"
        onclick={(e) => openMenu("model", e)}
        disabled={models.length === 0 || !ready}
        aria-haspopup="menu"
        aria-expanded={menu === "model"}
        title={defaultModel ? "The agent's default model, which the session runs on" : "The model the session runs on"}
        data-testid="model-chip"><Plain text={modelLabel} /><Icon name="down" size={12} /></button
      >
      {#if menu === "model"}
        <ChoiceMenu
          label="Model"
          choices={modelChoices(conversation)}
          note={conversation.current !== null ? "A model chosen now is used from the next turn." : null}
          onpick={(value) => pick("model", value)}
          onclose={closeMenu}
          pointer={byPointer}
          testid="model-menu"
          optionTestid="model-option"
        />
      {/if}
    </div>
    {#if after !== null}
      <span class="after" data-testid="model-after-turn"><Plain text={modelName(conversation, after) ?? after} /> from the next turn</span>
    {/if}
    {#if mode !== null}
      <div class="picker">
        <button
          class="chip"
          tabindex="0"
          onclick={(e) => openMenu("mode", e)}
          disabled={modes.length === 0 || !ready}
          aria-haspopup="menu"
          aria-expanded={menu === "mode"}
          title="What the agent may do without asking"
          data-testid="mode-chip"><Plain text={modeLabel} /><Icon name="down" size={12} /></button
        >
        {#if menu === "mode"}
          <ChoiceMenu
            label="Mode"
            choices={modeChoices(conversation)}
            onpick={(value) => pick("mode", value)}
            onclose={closeMenu}
            pointer={byPointer}
            testid="mode-menu"
            optionTestid="mode-option"
          />
        {/if}
      </div>
    {/if}
    {#if link.configureError !== null}
      <span class="error" title={shown(link.configureError)}>Not changed: <Plain text={link.configureError} /></span>
    {/if}
    {#if link.compactError !== null}
      <span class="error" title={shown(link.compactError)} data-testid="compact-error"
        >Not compacted: <Plain text={link.compactError} /></span
      >
    {/if}
    <span class="ctx" title={context?.title}>{context?.text ?? ""}</span>
    {#if running}
      <button class="round stop" tabindex="0" onclick={stop} aria-label="Stop" title="Stop the agent (Esc)" data-testid="stop"
        ><Icon name="stop" size={12} /></button
      >
    {/if}
    {#if !running || hasWords}
      <button
        class="round send"
        tabindex="0"
        onclick={submit}
        disabled={!ready || !hasWords || reading > 0}
        aria-label={running ? "Send, to wait for the agent" : "Send"}
        title={running ? "Send; it waits until the agent is done (Enter)" : "Send (Enter)"}
        data-testid="send"><Icon name="up" size={14} /></button
      >
    {/if}
  </div>
</div>

<style>
  .composer {
    position: relative;
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
    color: var(--ink-2);
  }

  /* The argument hint of a command just put in the field, drawn after what
     is written as if typed there, in grey. */
  .write {
    position: relative;
    display: flex;
  }

  .ghost {
    position: absolute;
    inset: 0;
    padding: 0 2px;
    font-size: var(--conv-size);
    line-height: 1.5;
    color: var(--ink-3);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    overflow: hidden;
    pointer-events: none;
  }

  .ghost .typed {
    visibility: hidden;
  }

  /* A command in the menu: its name with the letters typed marked and its
     argument hint, what it does, and where it comes from. */
  .cmd-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
    font-size: calc(var(--row-size) - 0.5px);
    color: var(--ink);
    white-space: nowrap;
  }

  .cmd-name b {
    font-weight: 700;
    color: var(--accent);
  }

  .cmd-hint {
    margin-left: 6px;
    color: var(--ink-3);
  }

  .cmd-about {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-source {
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-3);
    white-space: nowrap;
  }

  /* In a narrow pane the name and what it does keep the room. */
  @container conversation (max-width: 420px) {
    .cmd-source {
      display: none;
    }
  }

  code {
    font-family: var(--mono);
    font-size: calc(var(--row-size) - 0.5px);
    color: var(--ink);
  }

  .hint {
    margin: 0;
    padding: 0 2px;
    font-size: var(--conv-meta);
    color: var(--ink-2);
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
    border-radius: calc(var(--radius) * 4);
    background: var(--ink);
    color: var(--surface);
    cursor: pointer;
  }

  .reading {
    font-size: var(--conv-meta);
    color: var(--ink-2);
  }

  /* The bar wraps where the pane is too narrow for all of it on one line,
     so nothing in it is drawn over another. */
  .bar {
    display: flex;
    flex-wrap: wrap;
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
    border-radius: calc(var(--radius) * 4);
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font: inherit;
    font-size: var(--conv-meta);
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

  .picker {
    position: relative;
    flex: none;
  }

  .after {
    font-size: var(--conv-meta);
    color: var(--ink-2);
    white-space: nowrap;
  }

  .error {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--conv-meta);
    color: var(--del);
  }

  .ctx {
    margin-left: auto;
    padding-right: 4px;
    font-size: var(--conv-meta);
    color: var(--ink-2);
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
    border-radius: calc(var(--radius) * 4);
    cursor: pointer;
  }

  .send {
    background: var(--accent);
    color: var(--surface);
  }

  .send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 86%, var(--ink));
  }

  .send:active:not(:disabled),
  .stop:active {
    transform: scale(0.94);
  }

  .stop:hover {
    background: color-mix(in srgb, var(--ink) 82%, var(--surface));
  }

  /* The ring sits clear of a filled button, where an inset one would not
     show against the fill. */
  .round:focus-visible,
  .remove:focus-visible {
    outline-offset: 2px;
  }

  .remove:hover {
    background: var(--del);
  }

  .remove:active {
    transform: scale(0.9);
  }

  .chip:active:not(:disabled) {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--ink-3);
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

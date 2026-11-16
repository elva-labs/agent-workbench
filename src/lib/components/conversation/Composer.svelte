<script lang="ts">
  import { tick, untrack } from "svelte";
  import { core, type IntegratedImage } from "$lib/core";
  import type { Attached } from "$lib/integrated.svelte";
  import type { Conversation } from "$lib/conversation.svelte";
  import { register, unregister } from "$lib/drops.svelte";
  import { compact, follow, interrupt, linkFor, send } from "$lib/integrated.svelte";
  import { layout, overlayHoldsKeyboard } from "$lib/layout.svelte";
  import { choose, heldModel, modeChoices, modeName, modelChoices, workflowChoices } from "$lib/settingChoices";
  import type { AgentId, Workflow } from "$lib/core";
  import { modelName, tokens } from "$lib/thread";
  import { pieces } from "$lib/completion";
  import { complete, named, slashGroups, slashWord, sourceOf, waitingHint } from "$lib/slash";
  import {
    forAgent,
    mentionSpans,
    mentionWord,
    outgoing,
    parts,
    size,
    split,
    typedWords,
    unsafe,
    type Found,
  } from "$lib/mention";
  import { finder, find, isListed, LIMIT, list } from "$lib/mentionFiles.svelte";
  import { lastSegment } from "$lib/paths";
  import { isRemote } from "$lib/remote.svelte";
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
   *
   * An `@` typed at the start or after a space opens the project's files in
   * the same menu: what changed first, then the top of the project, and,
   * once something follows the `@`, the files and folders it names. A file
   * picked goes in as its path, drawn in the accent, and Backspace right
   * after it takes it out whole. It goes to the agent as the path, for the
   * agent to read itself. A file attached that is not an image goes the
   * same way, shown as a card above the field until it is sent.
   *
   * A new conversation nothing has been said in yet offers the workflows
   * beside the model and the mode: picking one makes the session its
   * orchestrator, picking none makes it the agent alone. Once a message
   * is sent the choice is kept, and the chip goes. While the session
   * follows a workflow the model chip shows the orchestrator's model and
   * holds it, saying the workflow sets it.
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
    /** Whether the dock holds something the user answers there. */
    answers?: boolean;
    /** Whether the session runs on the agent's default model, the user
        having chosen none. */
    defaultModel?: boolean;
    /** Whether the agent lists slash commands once ready. */
    slash?: boolean;
    /** The folder the project's files are listed from, for `@`; null for
        a folder git lists nothing in. */
    root?: string | null;
    /** Where the agent works, which a path it is told of is written from. */
    dir?: string;
    /** The project's name, as the menu says it. */
    project?: string;
    /** The agent the session runs on. */
    agentId?: AgentId;
    /** The name of the agent it runs on under no workflow. */
    alone?: string;
    /** The workflow the session follows, which holds its model; null for
        none. */
    workflow?: Workflow | null;
    /** Whether the workflow can still be chosen: nothing has been said in
        the session yet. */
    choosable?: boolean;
  }

  let {
    sessionKey,
    conversation,
    agent,
    ready,
    active,
    onDock,
    answers = false,
    defaultModel = false,
    slash = false,
    root = null,
    dir = "",
    project = "the project",
    agentId = "claude-code",
    alone = agent,
    workflow = null,
    choosable = false,
  }: Props = $props();

  let link = $derived(linkFor(sessionKey));
  let field = $state<HTMLTextAreaElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  /** The menu open over the composer's bar, if one is. */
  let menu = $state<"model" | "mode" | "workflow" | null>(null);
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

  $effect(() => {
    if (dismissed !== null && link.draft !== dismissed) dismissed = null;
  });
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
  /** A message that begins with a slash waits for the agent's list, so
      nothing it would take as a command goes as text before it can. */
  let unlisted = $derived(slash && conversation.ready === null && link.draft.startsWith("/"));
  /** What the menu holds, for a screen reader, said as it opens and
      changes. */
  let announced = $derived.by(() => {
    if (slashMenu === "starting") return `${agent} is still starting. Its commands show here once it is ready.`;
    if (slashMenu === "none")
      return `No command or skill is called ${link.draft.slice(0, word?.end ?? 0)}. Enter sends it as a message.`;
    if (slashMenu !== "list") return "";
    const count = matches.length;
    if (word?.query === "") return `${count} ${count === 1 ? "command or skill" : "commands and skills"}`;
    return `${count} ${count === 1 ? "match" : "matches"}`;
  });
  let menuId = $derived(`slash-${sessionKey.replace(/[^\w-]/g, "_")}`);

  // ---- files mentioned with @ ----

  /** An input method is putting a character together in the field. */
  let composing = $state(false);
  /** The folder the agent works in, from the project's root, with a slash
      after it; empty when it works at the root. */
  let under = $derived.by(() => {
    if (root === null) return "";
    const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
    const own = (dir || root).replaceAll("\\", "/").replace(/\/+$/, "");
    return own.startsWith(`${base}/`) ? `${own.slice(base.length + 1)}/` : "";
  });
  /** The paths typed whole after an `@`, the word done, that are files in
      the listing: mentions as much as picked ones. */
  function typedPaths(skip: ReturnType<typeof mentionWord>): string[] {
    if (root === null || finder.root !== root || !finder.listed) return [];
    return typedWords(link.draft, skip).filter((path) => isListed(`${under}${path}`) && unsafe(path) === null);
  }
  /** The `@` word the caret is in, whatever the menu does. */
  let typing = $derived(focused && dismissed !== link.draft ? mentionWord(link.draft, caret) : null);
  let typed = $derived(typedPaths(typing));
  /** Where the mentions stand in the message: those picked, and those
      typed whole. */
  let spans = $derived(mentionSpans(link.draft, [...link.mentions, ...typed]));
  /** Something about a file that did not go in: said under the field until
      the message is sent or something else is said. */
  let notice = $state<string | null>(null);
  let mword = $derived.by(() => {
    if (root === null || !focused || composing || word !== null || dismissed === link.draft) return null;
    const found = mentionWord(link.draft, caret);
    if (found === null || spans.some((span) => caret > span.start && caret <= span.end)) return null;
    return found;
  });
  let opened = $derived(mword !== null);
  let query = $derived(mword?.query ?? null);

  // The files are read again each time the menu opens, never on a key.
  $effect(() => {
    if (!opened || root === null) return;
    const from = root;
    untrack(() => void list(from));
  });

  $effect(() => {
    const wanted = query;
    if (wanted !== null && wanted !== "") untrack(() => find(wanted));
  });

  let changedBy = $derived(new Map(finder.changed.map((file) => [file.path, file])));
  let fileGroups = $derived.by((): { label: string; items: Found[] }[] => {
    if (mword === null || finder.root !== root) return [];
    if (mword.query === "") {
      const changed = finder.changed.slice(0, LIMIT).map((file) => ({ path: file.path, marks: [] }));
      const top = finder.top
        .filter((path) => !changedBy.has(path))
        .slice(0, LIMIT)
        .map((path) => ({ path, marks: [] }));
      return [
        { label: "Changed", items: changed },
        { label: "Files", items: top },
      ].filter((group) => group.items.length > 0);
    }
    if (finder.found.query === null || finder.found.paths.length === 0) return [];
    return [{ label: "", items: finder.found.paths }];
  });
  let fileItems = $derived(fileGroups.flatMap((group) => group.items));
  /** What the menu shows for `@`: the files, none that match, the files
      still being read, or why they could not be. */
  let fileMenu = $derived.by((): "list" | "none" | "reading" | "error" | null => {
    if (mword === null) return null;
    if (fileItems.length > 0) return "list";
    if (finder.root === root && finder.error !== null) return "error";
    if (finder.root !== root || !finder.listed) return "reading";
    if (mword.query !== "" && finder.found.query !== mword.query) return "reading";
    return "none";
  });
  let fileMarking = $derived(
    mword !== null && marked.query === `@${mword.query}` ? Math.min(marked.index, Math.max(0, fileItems.length - 1)) : 0,
  );
  let fileMenuId = $derived(`files-${sessionKey.replace(/[^\w-]/g, "_")}`);
  let fileAnnounced = $derived.by(() => {
    if (fileMenu === "reading") return `Reading the files of ${project}.`;
    if (fileMenu === "error") return `The files of ${project} could not be read.`;
    if (fileMenu === "none")
      return mword?.query === "" ? `No files in ${project}.` : `No file in ${project} matches ${mword?.query}.`;
    if (fileMenu !== "list") return "";
    const count = mword?.query === "" ? fileItems.length : finder.found.total;
    return `${count} ${count === 1 ? "file" : "files"}`;
  });

  /** Puts the file at that place in the menu in the field as a mention, a
      space after it, with the caret there. */
  function mentionAt(index: number) {
    const item = fileItems[index];
    if (item === undefined || mword === null || root === null) return;
    const path = forAgent(item.path, root, dir || root);
    const why = unsafe(path);
    if (why !== null) {
      notice = `Not mentioned: ${shown(path)}, since ${why}.`;
      return;
    }
    // The word, and the space or tab after it that the mention's own
    // space stands for.
    const end = /^[ \t]/.test(link.draft.slice(mword.end)) ? mword.end + 1 : mword.end;
    link.mentions = [...link.mentions.filter((known) => known !== path), path];
    edit(mword.at, end, `@${path} `);
  }

  /** Puts `text` in place of the field's letters from `from` to `to` as
      typing would, so undo and redo take it back and bring it again. A
      field that cannot is given the new message. */
  function edit(from: number, to: number, text: string) {
    if (field !== null) {
      field.focus();
      field.setSelectionRange(from, to);
      let done = false;
      try {
        done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
      } catch {
        done = false;
      }
      if (done && field.value !== link.draft) link.draft = field.value;
      if (done) {
        caret = field.selectionStart;
        return;
      }
    }
    link.draft = link.draft.slice(0, from) + text + link.draft.slice(to);
    caret = from + text.length;
    const at = caret;
    void tick().then(() => {
      field?.focus();
      field?.setSelectionRange(at, at);
    });
  }

  /** Backspace right after a mention takes all of it out. */
  function takeOut(e: KeyboardEvent): boolean {
    if (e.key !== "Backspace" || e.isComposing || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (field === null || field.selectionStart !== field.selectionEnd) return false;
    const at = field.selectionStart;
    const span = spans.find((known) => known.end === at);
    if (span === undefined) return false;
    e.preventDefault();
    edit(span.start, span.end, "");
    return true;
  }

  /** The field draws its text itself unless a mention is in it: then the
      text is drawn behind it, the mentions in the accent, and the field's
      own is clear. While an input method composes, the field draws. */
  let drawn = $derived((spans.length > 0 || mword !== null) && !composing);
  /** What the text behind the field draws in the accent: the picked
      mentions, and the `@` word being typed. */
  let accented = $derived(
    mword === null ? spans : [...spans, { start: mword.at, end: mword.end, path: "" }].sort((a, b) => a.start - b.start),
  );
  let backdrop = $state<HTMLDivElement | null>(null);
  /** The room a scroll bar takes in the field, which the text behind it
      leaves too. */
  let gutter = $state(0);

  function scrolled() {
    if (backdrop !== null && field !== null) backdrop.scrollTop = field.scrollTop;
  }

  function seen() {
    if (field !== null) caret = field.selectionStart;
  }

  function mark(index: number) {
    marked = { query: word !== null ? word.query : mword !== null ? `@${mword.query}` : "", index };
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
    if (slashMenu === null) return fileKey(e);
    if (e.isComposing || e.keyCode === 229) return false;
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissed = link.draft;
      return true;
    }
    // Nothing is sent as text that the agent, once ready, may take as a
    // command.
    if (slashMenu === "starting" && e.key === "Enter" && plain) {
      e.preventDefault();
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

  /** The keys the `@` menu takes while it is open, as the slash menu's. */
  function fileKey(e: KeyboardEvent): boolean {
    if (fileMenu === null || e.isComposing || e.keyCode === 229) return false;
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissed = link.draft;
      return true;
    }
    if (!plain) return false;
    // Tab or Enter before the files for what is typed are in picks the
    // best of them once they are, rather than sending the word as text.
    if ((e.key === "Enter" || e.key === "Tab") && (fileMenu === "reading" || (fileMenu === "list" && !answered))) {
      e.preventDefault();
      awaited = { draft: link.draft, key: e.key };
      return true;
    }
    if (fileMenu !== "list") return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      mark((fileMarking + step + fileItems.length) % fileItems.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      mentionAt(fileMarking);
      return true;
    }
    return false;
  }

  /** Whether the menu's rows are for what is typed now. */
  let answered = $derived(mword !== null && (mword.query === "" || finder.found.query === mword.query));
  /** The message as it stood when Tab or Enter came before the files for
      it: the best of them is picked once they are in, unless it changed. */
  let awaited = $state<{ draft: string; key: string } | null>(null);

  $effect(() => {
    if (awaited === null) return;
    if (link.draft !== awaited.draft || fileMenu === null) {
      awaited = null;
      return;
    }
    // With nothing to pick, a held Enter sends as it would have, and a
    // held Tab does nothing.
    if (fileMenu === "none" || fileMenu === "error") {
      const key = awaited.key;
      awaited = null;
      if (key === "Enter") untrack(submit);
      return;
    }
    if (fileMenu === "list" && answered)
      untrack(() => {
        awaited = null;
        mentionAt(0);
      });
  });

  let running = $derived(conversation.current !== null || conversation.working);
  let hasWords = $derived(link.draft.trim() !== "" || link.images.length > 0 || link.files.length > 0);
  /** The keys the empty field names, for what the agent and project take. */
  let keysSaid = $derived.by(() => {
    const keys = [slash ? "/ for commands" : null, root !== null ? "@ for files" : null].filter((key) => key !== null);
    return keys.length === 0 ? "" : `. Type ${keys.join(", ")}`;
  });

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
    if (reading === 0 && held && !link.restarting) {
      held = false;
      untrack(submit);
    }
  });

  $effect(() => {
    // The words changed: a warning about the last ones no longer holds.
    if (digit !== null && link.draft.trim() !== digit) digit = null;
  });

  function submit() {
    if (!ready || !hasWords || unlisted) return;
    if (reading > 0 || link.restarting) {
      held = true;
      return;
    }
    const lone = link.draft.trim();
    if (answers && link.images.length === 0 && /^[0-9]$/.test(lone) && digit !== lone) {
      digit = lone;
      return;
    }
    digit = null;
    const asked =
      slash && link.images.length === 0 && link.files.length === 0 ? named(link.draft, commands) : null;
    if (asked?.command.name === "compact") {
      // The words come back if the compaction could not be asked for.
      const typed = link.draft;
      const held = link;
      link.draft = "";
      void tick().then(grow);
      void compact(sessionKey, asked.rest).then((done) => {
        if (!done && held.draft === "") held.draft = typed;
      });
      return;
    }
    const sent = outgoing(
      link.draft,
      [...link.mentions, ...typedPaths(null)],
      link.files.map((file) => file.path),
    );
    const id = send(sessionKey, sent.text, link.images, null, sent.mentions);
    if (id === null) return;
    notice = null;
    link.draft = "";
    link.images = [];
    link.mentions = [];
    link.files = [];
    void tick().then(grow);
  }

  function stop() {
    interrupt(sessionKey);
  }

  function onkeydown(e: KeyboardEvent) {
    if (menuKey(e)) return;
    if (takeOut(e)) return;
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
    // Out of view the field has no size to grow to; it grows when back.
    if (field === null || field.getClientRects().length === 0) return;
    // The composer keeps its height while the field is measured, so the
    // thread above it is never taller for that moment: a browser pulls a
    // thread at its foot up to fit, and nothing after puts it back.
    if (box !== null) box.style.minHeight = `${box.offsetHeight}px`;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
    if (box !== null) box.style.minHeight = "";
    gutter = field.offsetWidth - field.clientWidth;
    scrolled();
  }

  $effect(() => {
    void link.draft;
    untrack(grow);
  });

  // A pane made narrower can wrap the message again, and give the field a
  // scroll bar, with no key typed.
  $effect(() => {
    if (field === null) return;
    const watch = new ResizeObserver(() => grow());
    watch.observe(field.parentElement ?? field);
    return () => watch.disconnect();
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

  /** Files from this machine that an agent on another cannot read: said
      under the field until the message changes. */
  /** Files dropped on the conversation or picked with the paper clip: an
      image goes with the message as a picture, anything else as a card,
      for the agent to read by its path. A file outside the project goes
      by its full path, and the card says which folder it is from. An
      agent on another machine is given only pictures: the files are on
      this one. */
  async function take(paths: string[]) {
    const away: string[] = [];
    const refused: string[] = [];
    for (const path of paths) {
      if (IMAGE_FILE.test(path)) {
        reading += 1;
        try {
          const found = await core().readMedia(path);
          if (IMAGES.includes(found.mime)) {
            link.images = [...link.images, { mediaType: found.mime, data: found.data }];
            continue;
          }
        } catch {
          // Read as a file instead.
        } finally {
          reading -= 1;
        }
      }
      if (isRemote(dir || (root ?? ""))) {
        away.push(lastSegment(path));
        continue;
      }
      const why = card(path);
      if (why !== null) refused.push(`Not attached: ${shown(path)}, since ${why}.`);
    }
    const said = [
      away.length === 0
        ? null
        : `Not attached: ${away.join(", ")}. ${agent} runs on another machine and cannot read files from this one; only pictures go with the message.`,
      ...refused,
    ].filter((line) => line !== null);
    notice = said.length === 0 ? null : said.join(" ");
  }

  /** A card for a file that is not an image, its size filled in once
      read. */
  function card(local: string): string | null {
    const why = unsafe(local);
    if (why !== null) return why;
    const base = dir || root || "";
    const told = base === "" ? local : forAgent(local, base, base);
    if (link.files.some((file) => file.path === told)) return null;
    const inside = told !== local || (root !== null && forAgent(local, root, root) !== local);
    const parent = local.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
    const attached: Attached = {
      path: told,
      name: lastSegment(local),
      size: null,
      dir: false,
      from: inside ? null : lastSegment(parent) || parent,
    };
    link.files = [...link.files, attached];
    void sized(local, told);
    return null;
  }

  /** Fills in a card's size, or says it is a folder. */
  async function sized(local: string, told: string) {
    try {
      const info = await core().fileInfo(local);
      link.files = link.files.map((file) =>
        file.path === told ? { ...file, size: info.dir ? null : info.size, dir: info.dir } : file,
      );
    } catch {
      // The card goes without its size.
    }
  }

  async function pickFiles() {
    const paths = await core().pickFiles();
    if (paths.length > 0) await take(paths);
    field?.focus();
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

  function unattach(file: Attached) {
    link.files = link.files.filter((known) => known !== file);
    field?.focus();
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
  // the keyboard here, unless another control of this same session has it,
  // a control of the pane's own does, such as the workflow tag in its
  // header, or a dialog holds it. A control of a session now hidden does
  // not count.
  $effect(() => {
    layout.focusRequest;
    const focused = layout.focus === "agent";
    if (!focused || !active || field === null) return;
    untrack(() => {
      if (overlayHoldsKeyboard()) return;
      const owner = document.activeElement;
      if (owner !== null && owner !== document.body && owner !== field) {
        const own = field!.closest("[data-session]");
        const pane = field!.closest("section[data-pane]");
        if (own?.contains(owner)) return;
        if (pane?.contains(owner) && owner.closest("[data-session]") === null) return;
      }
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
  let modeLabel = $derived(mode === null ? "Mode" : modeName(conversation, mode));

  function pick(setting: "model" | "mode", value: string) {
    menu = null;
    choose(sessionKey, conversation, setting, value);
    field?.focus();
  }

  // ---- the workflow ----

  /** The model a workflow holds the session to, as the chip says it. */
  let heldName = $derived(workflow === null ? null : heldModel(conversation, workflow));
  let workflowLabel = $derived(workflow?.name ?? "No workflow");

  function pickWorkflow(value: string) {
    menu = null;
    follow(sessionKey, value === "" ? null : value);
    field?.focus();
  }

  // The choice goes with the chip once something is said.
  $effect(() => {
    if (!choosable && untrack(() => menu) === "workflow") menu = null;
  });

  function closeMenu(how: "escape" | "tab" | "away") {
    const which = menu;
    menu = null;
    if (how === "escape")
      void tick().then(() => box?.querySelector<HTMLButtonElement>(`[data-testid='${which}-chip']`)?.focus());
  }

  function openMenu(which: "model" | "mode" | "workflow", e: MouseEvent) {
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
        {@const source = sourceOf(match.item)}
        <!-- A screen reader hears the parts apart, by commas drawn at no
             size at the end of each. -->
        <span class="cmd-name" data-testid="slash-name"
          >/{#each pieces(match.item.name, match.marks) as piece, at (at)}{#if piece.hit}<b><Plain text={piece.text} /></b
              >{:else}<Plain text={piece.text} />{/if}{/each}{#if match.item.hint !== null}<span class="sep">,</span> <span
                class="cmd-hint"><Plain text={match.item.hint} /></span
              >{/if}{#if match.item.description !== null || source !== ""}<span class="sep">,</span>{/if}</span
        >
        <span class="cmd-about"
          >{#if match.item.description !== null}<Plain text={match.item.description} />{#if source !== ""}<span class="sep"
                >,</span
              >{/if}{/if}</span
        >
        <span class="cmd-source"><Plain text={source} /></span>
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
  {:else if fileMenu !== null}
    <CompletionMenu
      id={fileMenuId}
      label="Files"
      groups={fileGroups}
      active={fileMarking}
      key={(found) => found.path}
      action="mention"
      onpick={mentionAt}
      onpoint={mark}
      testid="file-menu"
    >
      {#snippet row(found)}
        {@const cut = split(found)}
        {@const changed = changedBy.get(found.path)}
        <!-- A screen reader hears the parts apart, by commas drawn at no
             size at the end of each. -->
        <span class="file-name" data-testid="file-name"
          ><Icon name={found.path.endsWith("/") ? "folder" : "file"} size={13} /><span
            >{#each pieces(cut.name, cut.nameMarks) as piece, at (at)}{#if piece.hit}<b><Plain text={piece.text} /></b
                >{:else}<Plain text={piece.text} />{/if}{/each}</span
          >{#if cut.dir !== "" || changed !== undefined}<span class="sep">,</span>{/if}</span
        >
        <span class="file-dir" data-testid="file-dir"
          ><span dir="ltr"
            >{#each pieces(cut.dir, cut.dirMarks) as piece, at (at)}{#if piece.hit}<b><Plain text={piece.text} /></b
                >{:else}<Plain text={piece.text} />{/if}{/each}</span
          >{#if cut.dir !== "" && changed !== undefined}<span class="sep">,</span>{/if}</span
        >
        <span class="file-change"
          >{#if changed !== undefined}{#if changed.binary}<span class="file-bin">binary</span>{:else}<span class="plus"
                >+{changed.add}</span
              >
              <span class="minus">−{changed.del}</span>{/if}{/if}</span
        >
      {/snippet}
      {#snippet empty()}
        {#if fileMenu === "reading"}
          Reading the files of <Plain text={project} />…
        {:else if fileMenu === "error"}
          The files of <Plain text={project} /> could not be read.
        {:else if mword?.query === ""}
          No files in <Plain text={project} />.
        {:else}
          No file in <Plain text={project} /> matches <code><Plain text={mword?.query ?? ""} /></code>.
        {/if}
      {/snippet}
    </CompletionMenu>
  {/if}
  <p class="sr" role="status" data-testid="slash-announce">{slashMenu !== null ? announced : fileAnnounced}</p>
  {#if link.images.length > 0 || link.files.length > 0 || reading > 0}
    <div class="attached" data-testid="attachments">
      {#each link.images as image, at (at)}
        <span class="thumb">
          <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          <button class="remove" tabindex="0" onclick={() => remove(image)} aria-label="Remove image {at + 1}" data-testid="remove-attachment"
            ><Icon name="x" size={10} /></button
          >
        </span>
      {/each}
      {#each link.files as file (file.path)}
        {@const about = [
          file.dir ? "Folder" : file.size === null ? null : size(file.size),
          file.from === null ? null : `from ${file.from}`,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        <span class="card" title={file.path} data-testid="attached-file">
          <Icon name={file.dir ? "folder" : "file"} />
          <span class="card-text"
            ><span class="card-name"><Plain text={file.name} />{#if about !== ""}<span class="sep">, </span>{/if}</span
            >{#if about !== ""}<small data-testid="attached-file-about">{about}</small>{/if}</span
          >
          <button
            class="remove"
            tabindex="0"
            onclick={() => unattach(file)}
            aria-label="Remove {file.name}"
            data-testid="remove-attached-file"><Icon name="x" size={10} /></button
          >
        </span>
      {/each}
      {#if reading > 0}<span class="reading">Reading…</span>{/if}
    </div>
  {/if}
  <div class="write">
    {#if drawn}
      <div class="backdrop" style:right="{gutter}px" aria-hidden="true" bind:this={backdrop} data-testid="composer-drawn"
        >{#each parts(link.draft, accented) as part, at (at)}{#if part.path !== undefined}<span
              class="mention"
              data-testid={part.path === "" ? "composer-typing" : "composer-mention"}>{part.text}</span
            >{:else}{part.text}{/if}{/each}{#if link.draft.endsWith("\n")}{"\u200b"}{/if}</div
      >
    {/if}
    <textarea
      bind:this={field}
      bind:value={link.draft}
      class:drawn
      {onkeydown}
      {onpaste}
      onscroll={scrolled}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => {
        composing = false;
        seen();
      }}
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
      placeholder={answers
        ? "↑ to answer, or write a message"
        : `${conversation.entries.length === 0 ? `Tell ${agent} what to do` : `Reply to ${agent}`}${keysSaid}`}
      aria-label="Message to {agent}"
      aria-autocomplete={slash || root !== null ? "list" : undefined}
      aria-controls={slashMenu === "list" ? menuId : fileMenu === "list" ? fileMenuId : undefined}
      aria-activedescendant={slashMenu === "list"
        ? rowId(menuId, marking)
        : fileMenu === "list"
          ? rowId(fileMenuId, fileMarking)
          : undefined}
      data-menu={slashMenu !== null || fileMenu !== null || menu !== null ? "" : undefined}
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
    <p class="hint" data-testid="composer-held">
      {reading > 0 ? "Sends once the images are read." : `Sends once ${agent} is ready.`}
    </p>
  {:else if notice !== null}
    <p class="hint" data-testid="composer-notice"><Plain text={notice} /></p>
  {:else if link.compactAsked && running && !conversation.compacting}
    <p class="hint" data-testid="composer-compact">Compacts once {agent} is done with this turn.</p>
  {/if}
  <div class="bar">
    <button class="chip bare" tabindex="0" onclick={() => void pickFiles()} aria-label="Attach files" title="Attach files" data-testid="attach"
      ><Icon name="clip" /></button
    >
    <div class="picker">
      {#if workflow !== null && heldName !== null}
        <!-- The workflow sets the orchestrator's model, so it is not a
             choice here: it is reached like the others, says why, and
             opens nothing. -->
        <button
          class="chip"
          tabindex="0"
          aria-disabled="true"
          aria-label="Model {heldName}, set by {workflow.name}"
          title="Set by {workflow.name}"
          data-testid="model-chip"
          data-held=""><Plain text={heldName} /></button
        >
      {:else}
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
      {/if}
      {#if menu === "model" && workflow === null}
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
    {#if choosable}
      <div class="picker">
        <button
          class="chip"
          tabindex="0"
          onclick={(e) => openMenu("workflow", e)}
          aria-haspopup="menu"
          aria-expanded={menu === "workflow"}
          aria-label="Workflow: {workflow?.name ?? 'none'}"
          title="The workflow this session follows, chosen before its first message"
          data-testid="workflow-chip"
          ><Icon name="flow" size={13} /><Plain text={workflowLabel} /><Icon name="down" size={12} /></button
        >
        {#if menu === "workflow"}
          <ChoiceMenu
            label="Workflow"
            choices={workflowChoices(agentId, alone, workflow)}
            note="Chosen before the first message, then kept."
            onpick={pickWorkflow}
            onclose={closeMenu}
            pointer={byPointer}
            end
            within={box}
            testid="workflow-menu"
            optionTestid="workflow-option"
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
    <span class="end">
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
          disabled={!ready || !hasWords || reading > 0 || unlisted}
          aria-label={running ? "Send, to wait for the agent" : "Send"}
          title={unlisted
            ? `Sends once ${agent} has listed its commands`
            : running
              ? "Send; it waits until the agent is done (Enter)"
              : "Send (Enter)"}
          data-testid="send"><Icon name="up" size={14} /></button
        >
      {/if}
    </span>
  </div>
</div>

<style>
  .composer {
    position: relative;
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

  /* The message drawn behind a field whose own text is clear, so a
     mention in it can be in the accent. It wraps and scrolls as the field
     does. */
  .backdrop {
    position: absolute;
    inset: 0;
    padding: 0 2px;
    font-size: var(--conv-size);
    line-height: 1.5;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    overflow: hidden;
    pointer-events: none;
  }

  .mention {
    color: var(--accent);
  }

  textarea {
    position: relative;
  }

  textarea.drawn {
    color: transparent;
    caret-color: var(--ink);
  }

  textarea.drawn::selection {
    color: transparent;
    background: color-mix(in srgb, var(--accent) 26%, transparent);
  }

  /* A file in the menu: its name with the letters typed marked, the folder
     it is in, cut at the start when long, and its counts when changed. */
  .file-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
    white-space: nowrap;
  }

  .file-name :global(svg) {
    display: inline-block;
    margin-right: 8px;
    vertical-align: -2px;
    color: var(--ink-3);
  }

  .file-name b,
  .file-dir b {
    font-weight: 700;
    color: var(--accent);
  }

  .file-dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-3);
  }

  .file-dir > span {
    unicode-bidi: isolate;
  }

  .file-change {
    font-size: calc(var(--meta-size) - 0.5px);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .plus {
    color: var(--add);
  }

  .minus {
    color: var(--del);
  }

  .file-bin {
    color: var(--ink-3);
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

  /* Set apart from the name by a space. */
  .cmd-hint {
    color: var(--ink-3);
  }

  .cmd-about {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-source {
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: calc(var(--meta-size) - 0.5px);
    color: var(--ink-3);
    white-space: nowrap;
  }

  .sep {
    font-size: 0;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* In a narrow pane the name and what it does keep the room. */
  :global(.conv.tight) .cmd-source {
    display: none;
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

  /* A file that is not an image: its name and size, and the folder it is
     from when that is outside the project. */
  .card {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 280px;
    height: 40px;
    padding: 0 14px 0 10px;
    border-radius: var(--radius);
    background: var(--clear-surface);
    box-shadow: inset 0 0 0 1px var(--rule);
    font-size: var(--conv-small);
    color: var(--ink);
  }

  .card > :global(svg) {
    flex: none;
    color: var(--ink-3);
  }

  .card-text {
    min-width: 0;
    line-height: 1.3;
  }

  .card-name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--conv-fine);
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

  .chip:hover:not(:disabled, [aria-disabled="true"]) {
    color: var(--ink);
    background: var(--paint-surface);
  }

  .chip:disabled,
  .chip[aria-disabled="true"] {
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

  /* What the context takes, and Send or Stop, keep to the right end
     together, on the bar's last line when it wraps. */
  .end {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ctx {
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

  .chip:active:not(:disabled, [aria-disabled="true"]) {
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

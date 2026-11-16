<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import type { Request } from "$lib/conversation.svelte";
  import type { IntegratedEventBody, PermissionOffer } from "$lib/core";
  import { accountWords, answerRound, roundQuestion, type Ask } from "$lib/conductor.svelte";
  import { askerOf, dockedFor, folderOf, type Docked } from "$lib/docked.svelte";
  import { answer, reply } from "$lib/integrated.svelte";
  import { focusPane } from "$lib/layout.svelte";
  import { showCall } from "$lib/callShown.svelte";
  import { goTo, projectLabel } from "$lib/workspace.svelte";
  import {
    address,
    asks,
    choiceLabel,
    choiceMeans,
    choiceMeansIn,
    place,
    requestCwd,
    requestPaths,
    shown as markers,
    type Piece,
  } from "$lib/thread";
  import Icon from "./Icon.svelte";
  import Plain from "./Plain.svelte";

  /**
   * What waits on the user, docked over the composer rather than in the
   * thread: a permission, said in words, with the choices the core offers,
   * each saying what it keeps; or a question, with its options and, where
   * it takes them, room for the user's own words, a secret one typed
   * hidden. The session's own come first, then those of the sessions it
   * started, each named by its session and answered as it would be there,
   * with the way to it; a session that runs in a terminal is answered
   * there, so its request offers only the way. A round of review past the
   * workflow's limit that this session asked for docks with its own. One
   * at a time: while the user is at the dock the one shown stays until it
   * is answered or goes, whatever comes in meanwhile, and one that takes
   * the place of another takes no answer for a moment, so nothing meant
   * for the last one answers it.
   *
   * The choices are one stop for the keyboard: the arrows move between
   * them, a digit picks one, and the first is the one that remembers
   * nothing. The dock never takes the keyboard by itself, so nothing typed
   * for something else answers it; Up from an empty composer reaches it.
   */
  interface Props {
    sessionKey: string;
    /** The session's agent, by the name it speaks under. */
    agent: string;
    /** The session is the one on screen. */
    active: boolean;
    /** Called once an answer is on its way, for the keyboard to go back. */
    onAnswered?: () => void;
  }

  let { sessionKey, agent, active, onAnswered }: Props = $props();

  type Permission = Extract<IntegratedEventBody, { type: "permissionAsked" }>;
  type Question = Extract<IntegratedEventBody, { type: "questionAsked" }>;

  let entries = $derived(dockedFor(sessionKey));

  /** The pointer is over the dock, or the keyboard in it. */
  let hovering = $state(false);
  let focused = $state(false);
  let hold = $state<HTMLDivElement | null>(null);
  /** Where the pointer last was in the window, for telling whether it is
      over the dock once what is drawn there changed under it. */
  let point: { x: number; y: number } | null = null;

  /** The entry on screen. The order decides it, except while the user is
      at the dock: then it stays while it waits, and what arrives meanwhile
      waits behind it, so nothing changes under the pointer or the keys. */
  let kept = $state<string | null>(null);
  let entry = $derived<Docked | null>(entries.find((each) => each.id === kept) ?? entries[0] ?? null);
  $effect(() => {
    const id = entry?.id ?? null;
    kept = active && (hovering || focused) ? id : null;
  });

  function onFocus() {
    focused = hold !== null && hold.contains(document.activeElement);
  }

  function onPointerOut(e: PointerEvent) {
    if (!(e.relatedTarget instanceof Node) || !hold?.contains(e.relatedTarget)) hovering = false;
  }

  function onPointerMove(e: PointerEvent) {
    point = { x: e.clientX, y: e.clientY };
  }

  /** Whether the pointer is over the dock as it is drawn now: the entry
      under it may have gone, or a smaller one taken its place, with no
      event to say the pointer left. */
  function overNow() {
    if (point === null || hold === null || typeof document.elementFromPoint !== "function") return;
    const under = document.elementFromPoint(point.x, point.y);
    hovering = under !== null && hold.contains(under);
  }

  /** Escape gives the keyboard back to the composer, as it does from the
      thread. */
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.isComposing) return;
    const field = hold?.closest("[data-session]")?.querySelector<HTMLElement>("[data-testid='composer-input']");
    if (!field) return;
    e.preventDefault();
    e.stopPropagation();
    field.focus();
  }

  let request = $derived<Request | null>(entry?.kind === "request" ? entry.request : null);
  let conversation = $derived(entry?.kind === "request" ? entry.conversation : null);
  /** The started session that asks, by name and step; null for this
      session's own. */
  let who = $derived(entry === null ? null : askerOf(entry));
  /** The folder the asking session works in. */
  let root = $derived(entry === null ? null : folderOf(entry));
  /** The asking session's name as the dock says it: cut like any long
      text an agent chose, since the starter's agent named it, with how
      much is cut said on the line. */
  let whoName = $derived(who === null ? null : cut(who.name));
  /** Who the choices speak of: the agent of this session, or the session
      that asks. */
  let named = $derived(whoName ?? agent);

  let others = $derived(entries.filter((each) => each.id !== entry?.id));
  /** Who waits after the one shown, when all of it is one session's and
      not only this session's own. */
  let next = $derived.by(() => {
    if (others.length === 0 || entries.every((each) => each.own)) return null;
    const keys = new Set(others.map((each) => each.key));
    if (keys.size > 1) return null;
    const first = askerOf(others[0]);
    return first === null ? agent : cut(first.name);
  });

  let dock = $state<HTMLDivElement | null>(null);

  /** How long an entry that took another's place takes no answer: one
      shown in place of another, or one shown this soon after the last
      left the dock. */
  const SETTLE = 500;
  /** Whether the entry shown takes an answer yet. */
  let armed = $state(true);
  let last: string | null = null;
  /** When the dock last emptied. */
  let leftAt = Number.NEGATIVE_INFINITY;
  let settling: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const id = entry?.id ?? null;
    untrack(() => {
      const now = Date.now();
      if (id !== null && id !== last && (last !== null || now - leftAt < SETTLE)) {
        armed = false;
        if (settling !== null) clearTimeout(settling);
        settling = setTimeout(() => {
          settling = null;
          armed = true;
        }, SETTLE);
      }
      if (id === null && last !== null) leftAt = now;
      last = id;
    });
  });
  onDestroy(() => {
    if (settling !== null) clearTimeout(settling);
  });

  /** Who asks: the agent, or a subagent of it, by what it was asked to do,
      which is the agent's text and drawn as it is. */
  function asker(parent: string | null): Piece[] {
    if (parent === null) return [agent];
    const call = conversation?.call(parent);
    const input = call?.input as Record<string, unknown> | null | undefined;
    const description = typeof input?.description === "string" ? input.description : null;
    if (who !== null)
      return description === null ? ["A subagent"] : ["The subagent for “", { name: cut(description) }, "”"];
    return description === null ? [`A subagent of ${agent}'s`] : ["The subagent for “", { name: cut(description) }, "”"];
  }

  /** What a subagent that asks was asked to do, as it wrote it. */
  function askerDescription(parent: string | null): string {
    if (parent === null) return "";
    const input = conversation?.call(parent)?.input as Record<string, unknown> | null | undefined;
    return typeof input?.description === "string" ? input.description : "";
  }

  /** Who asks, as a label, with what cannot be seen in it written out. */
  function askerLabel(parent: string | null): string {
    const lead = who === null || parent !== null ? asker(parent) : [];
    const said = lead.map((piece) => (typeof piece === "string" ? piece : markers(piece.name))).join("");
    if (whoName === null) return said;
    return parent === null ? whoName : `${said} in ${whoName}`;
  }

  /** Goes to the session that asks, with the keyboard, at the call that
      started the subagent when one asks. It answers nothing, so it waits
      on nothing. */
  function open() {
    if (entry === null) return;
    if (!goTo(entry.key)) return;
    const parent = request?.asked.parent ?? null;
    if (parent !== null) showCall(entry.key, parent);
    focusPane("agent");
  }

  // The dock going away by itself, a question that settled itself or a
  // request the agent withdrew, gives the keyboard back as an answer does
  // when the dock had it.
  let held = false;
  $effect.pre(() => {
    entry?.id;
    untrack(() => {
      held = dock !== null && dock.contains(document.activeElement);
    });
  });
  $effect(() => {
    const id = entry?.id ?? null;
    untrack(() => {
      // What was under the pointer or the keys may have gone with the
      // entry, and no event says so.
      onFocus();
      if (id === null) hovering = false;
      else void tick().then(overNow);
      if (!held) return;
      held = false;
      const owner = document.activeElement;
      if (owner === null || owner === document.body || !owner.isConnected) onAnswered?.();
    });
  });

  // ---- permissions ----

  /** The choice the help line speaks of: the one with the keyboard or the
      pointer, else the first. */
  let pointed = $state(0);
  /** Deny was picked, and waits for the user's words to go with it. */
  let denying = $state<PermissionOffer | null>(null);
  let words = $state("");

  $effect(() => {
    entry?.id;
    const asked = request?.asked;
    // A command of several lines is shown whole from the start, so no line
    // of it is out of sight when the choice is made.
    const command = (asked?.type === "permissionAsked" ? (asked.input as Record<string, unknown> | null) : null)
      ?.command;
    shown = typeof command === "string" && command.includes("\n");
    showChange = false;
    showWhole = false;
    showLong = false;
    pointed = 0;
    denying = null;
    words = "";
    picked = [];
    own = [];
  });

  /** Whether the request shown takes an answer now: not while one is on its
      way, nor while it settles in. Its controls say so without being
      disabled, so the keyboard stays on them until the request goes and
      can pass on to the next. */
  function takes(request: Request): boolean {
    return armed && !request.answering;
  }

  /** What a choice does, said of the session the request is in. */
  function means(offer: PermissionOffer): string {
    return who === null || whoName === null ? choiceMeans(offer) : choiceMeansIn(offer, whoName, who.where).join("");
  }

  function choose(offer: PermissionOffer) {
    if (entry === null || request === null || request.answering || !armed) return;
    if (offer.message && offer.choice === "deny" && denying === null) {
      denying = offer;
      void tick().then(() => dock?.querySelector<HTMLInputElement>("[data-testid='deny-words']")?.focus());
      return;
    }
    answer(entry.key, request.request, offer.choice, offer.choice === "deny" ? words : undefined);
    onAnswered?.();
  }

  /** The round past the limit, allowed this once or not. */
  function round(ask: Ask, allowed: boolean) {
    if (!armed) return;
    if (answerRound(ask, allowed)) onAnswered?.();
  }

  function onRoundKey(e: KeyboardEvent, ask: Ask) {
    if (/^[12]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      round(ask, e.key === "1");
      return;
    }
    onChoicesKey(e, []);
  }

  function onChoicesKey(e: KeyboardEvent, offers: PermissionOffer[]) {
    const buttons = [...(dock?.querySelectorAll<HTMLButtonElement>("[data-choice]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const offer = offers[Number(e.key) - 1];
      if (offer !== undefined) {
        e.preventDefault();
        choose(offer);
      }
      return;
    }
    if (next === null) return;
    e.preventDefault();
    pointed = next;
    buttons[next]?.focus();
  }

  function onWordsKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (denying !== null) choose(denying);
    } else if (e.key === "Escape") {
      // Back to the choices, rather than interrupting the turn.
      e.preventDefault();
      e.stopPropagation();
      denying = null;
      void tick().then(() => dock?.querySelector<HTMLButtonElement>("[data-choice]")?.focus());
    }
  }

  type Line = { kind: "add" | "del" | "ctx" | "head"; text: string };

  /** A long command whole, when the line holds only its first line or
      cuts it. */
  function wholeCommand(asked: Permission, shape: string | null): string | null {
    const command = (asked.input as Record<string, unknown> | null)?.command;
    if (shape !== "command" || typeof command !== "string") return null;
    return command.includes("\n") || command.length > 90 ? command : null;
  }

  /** A change the request makes, as the lines it takes out and puts in, by
      the shape of what it asks with; null when it lists none. */
  function change(asked: Permission): Line[] | null {
    const input = asked.input as Record<string, unknown> | null;
    if (input === null || typeof input !== "object") return null;
    if (typeof input.old_string === "string" && typeof input.new_string === "string")
      return [
        ...input.old_string.split("\n").map((text) => ({ kind: "del" as const, text })),
        ...input.new_string.split("\n").map((text) => ({ kind: "add" as const, text })),
      ];
    if (typeof input.content === "string")
      return input.content.split("\n").map((text) => ({ kind: "add" as const, text }));
    if (Array.isArray(input.changes)) {
      const lines: Line[] = [];
      for (const each of input.changes as Record<string, unknown>[]) {
        if (typeof each?.path === "string") lines.push({ kind: "head", text: each.path });
        const diff = typeof each?.diff === "string" ? each.diff : null;
        for (const line of diff?.split("\n") ?? []) {
          if (line.startsWith("+++") || line.startsWith("---")) continue;
          if (line.startsWith("@@")) lines.push({ kind: "head", text: line });
          else if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1) });
          else if (line.startsWith("-")) lines.push({ kind: "del", text: line.slice(1) });
          else if (line !== "") lines.push({ kind: "ctx", text: line.replace(/^ /, "") });
        }
      }
      return lines.length > 0 ? lines : null;
    }
    return null;
  }

  /** The whole request as the agent made it: the tool it names and all
      of its input, so nothing the line leaves out goes unseen. Null when
      the line already says all of it. */
  function whole(asked: Permission, what: { lead: Piece[]; object: string | null; shape: string | null }): string | null {
    const input = asked.input;
    if (input === null || input === undefined) return null;
    // A request the core cut is never said whole on its line.
    if (typeof input === "object" && !Array.isArray(input) && !asked.truncated) {
      const keys = Object.keys(input);
      if (keys.length === 0) return null;
      // Left out only where the line shows the input whole: a command of
      // one line, of a call known to be a command, and nothing else.
      const command = (input as Record<string, unknown>).command;
      if (
        keys.length === 1 &&
        what.lead.length === 1 &&
        what.lead[0] === "run" &&
        typeof command === "string" &&
        what.shape === "command" &&
        what.object === command &&
        !command.includes("\n") &&
        command.length <= 90
      )
        return null;
    }
    return `Tool: ${asked.tool}\n${JSON.stringify(input, null, 2)}`;
  }

  /** The paths a request names that are not plainly in the project: those
      outside it, and those it cannot be told of. */
  function outside(asked: Permission): { path: string; where: "outside" | "unknown" }[] {
    const cwd = requestCwd(asked);
    const out: { path: string; where: "outside" | "unknown" }[] = [];
    for (const path of requestPaths(asked)) {
      const at = place(path, root, path === cwd ? null : cwd).where;
      if (at !== "inside") out.push({ path, where: at });
    }
    return out;
  }

  /** Which of a request's folds are open: the whole command, the change,
      the whole request. */
  let shown = $state(false);
  let showChange = $state(false);
  let showWhole = $state(false);
  let showLong = $state(false);

  /** A path a request names, as the user must read it to decide: from the
      project when it is plainly inside it, and whole otherwise, said to be
      outside or not known to be inside. Nothing is cut out of it. */
  function where(asked: Permission, path: string) {
    return place(path, root, requestCwd(asked));
  }

  /** Said before a path that is not plainly in the project, so the path
      can never push it out of sight. */
  const AWAY = { outside: "a path outside the project:", unknown: "a path not plainly in the project:" } as const;

  /** How much of a command, path or name the line shows; the rest is a
      fold away. */
  const LONG = 160;

  /** Text cut to what the line shows, by characters. */
  function cut(text: string): string {
    const chars = Array.from(text);
    return chars.length > LONG ? `${chars.slice(0, LONG).join("")}…` : text;
  }

  function long(text: string): boolean {
    return Array.from(text).length > LONG;
  }

  /** How many characters a cut leaves out, said on the line in the warning
      colour, so what is cut off can never pass unseen. */
  function leftOut(text: string): number {
    return Math.max(0, Array.from(text).length - LONG);
  }

  const KINDS = ["outside", "unknown"] as const;

  /** A command's first line, and how many lines follow it. */
  function lines(command: string): { first: string; rest: number } {
    const all = command.split("\n");
    return { first: all[0], rest: all.length - 1 };
  }

  // ---- questions ----

  /** Per question, the options picked and the user's own words. */
  let picked = $state<string[][]>([]);
  let own = $state<string[]>([]);

  /** One question with one option to pick is answered by picking it; the
      rest are picked first and sent together. */
  function direct(questions: Question["questions"]): boolean {
    return questions.length === 1 && !questions[0].multiple && questions[0].options.length > 0;
  }

  function pick(at: number, label: string, multiple: boolean, questions: Question["questions"]) {
    if (direct(questions)) {
      if (entry === null || request === null || request.answering || !armed) return;
      reply(entry.key, request.request, [[label]]);
      onAnswered?.();
      return;
    }
    const now = picked[at] ?? [];
    picked[at] = multiple ? (now.includes(label) ? now.filter((known) => known !== label) : [...now, label]) : [label];
  }

  function answers(questions: Question["questions"]): string[][] | null {
    const out: string[][] = [];
    for (let at = 0; at < questions.length; at++) {
      const words = (own[at] ?? "").trim();
      const chosen = picked[at] ?? [];
      if (words !== "") out.push([words]);
      else if (chosen.length > 0) out.push(chosen);
      else return null;
    }
    return out;
  }

  function send(questions: Question["questions"]) {
    if (entry === null || request === null || request.answering || !armed) return;
    const given = answers(questions);
    if (given === null) return;
    reply(entry.key, request.request, given);
    onAnswered?.();
  }

  function decline() {
    if (entry === null || request === null || request.answering || !armed) return;
    reply(entry.key, request.request, null);
    onAnswered?.();
  }

  function onQuestionKey(e: KeyboardEvent, questions: Question["questions"]) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    e.preventDefault();
    send(questions);
  }

  function onOptionsKey(e: KeyboardEvent) {
    const group = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[data-option]");
    const items = [...group];
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const item = items[Number(e.key) - 1];
      if (item !== undefined) {
        e.preventDefault();
        item.click();
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    e.preventDefault();
    items[(at + step + items.length) % items.length]?.focus();
  }

  /** Puts the keyboard on the dock's first control. */
  export function focus() {
    dock?.querySelector<HTMLElement>("[data-choice], [data-option], input, textarea")?.focus();
  }
</script>

<svelte:window onfocusin={onFocus} onpointermove={onPointerMove} />

<!-- Holds whichever entry is shown, and says while the user is at it. -->
<div
  class="hold"
  bind:this={hold}
  onpointerover={() => (hovering = true)}
  onpointerout={onPointerOut}
  onfocusout={() => queueMicrotask(onFocus)}
  onkeydown={onKey}
  role="presentation"
>
{#if entry !== null}
  {#key entry.id}
  {#if entry.kind === "terminal"}
    <!-- A started session in a terminal: only its terminal answers it, so
         the dock offers the way there, and lets go once it stops asking. -->
    <div
      class="dock"
      bind:this={dock}
      role="group"
      aria-label="{named} is waiting for you in its terminal"
      data-testid="terminal-dock"
    >
      <div class="what">
        <span class="ring"></span>
        <p>{@render asking(null)} asks for a permission in its terminal</p>
        {@render waiting()}
      </div>
      <div class="choices">
        <button class="choice primary plain" tabindex="0" data-choice="open" onclick={open} data-testid="dock-open-terminal"
          ><span class="label">Open <Plain text={named} /></span></button
        >
      </div>
      <p class="means">It runs in a terminal, so it is answered there.</p>
    </div>
  {:else if entry.kind === "round"}
    {@const ask = entry.ask}
    {@const beyond = ask.round!}
    <!-- A round of review past the workflow's limit, which this session's
         start waits on: the user's yes lets this one round through. -->
    <div class="dock" bind:this={dock} role="group" aria-label="{agent} asks for another round of {beyond.step}" data-testid="round-dock">
      <div class="what">
        <span class="ring"></span>
        <p><b>{agent}</b> asks for another round of <Plain text={beyond.step} /></p>
        {@render waiting()}
      </div>
      <div class="body">
        <p class="description" data-testid="conduct-round"><Plain text={roundQuestion(beyond)} /></p>
        <p class="description">
          In <Plain text={projectLabel(ask.project)} />{ask.worktree ? ", in a worktree of its own" : ""}.{#if ask.named !== null}{" "}<span
              data-testid="conduct-account">{accountWords(ask.named)}</span
            >{/if}
        </p>
        {#if ask.prompt !== ""}<p class="prompt"><Plain text={ask.prompt} /></p>{/if}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="choices" onkeydown={(e) => onRoundKey(e, ask)}>
        {#each [true, false] as allowed, at (at)}
          <button
            class="choice"
            class:primary={allowed}
            tabindex={at === pointed ? 0 : -1}
            aria-disabled={armed ? undefined : "true"}
            aria-describedby="means-{sessionKey}"
            data-choice={allowed ? "round-allow" : "round-stop"}
            data-testid={allowed ? "conduct-allow-round" : "conduct-no"}
            onclick={() => round(ask, allowed)}
            onfocus={() => (pointed = at)}
            onpointerenter={() => (pointed = at)}
            ><span class="key">{at + 1}</span>{allowed ? "Allow one more round" : "Stop at the limit"}</button
          >
        {/each}
      </div>
      <p class="means" id="means-{sessionKey}" data-testid="choice-means">
        {pointed === 0
          ? "Starts this one round. A round after it is asked about again."
          : `Refuses the start, and ${agent} is told to ask you how to go on.`}
      </p>
    </div>
  {:else}
  {@const asked = entry.request.asked}
  {@const conversation = entry.conversation}
  <div
    class="dock"
    bind:this={dock}
    role="group"
    aria-label="{askerLabel(asked.parent)} is waiting for you"
    data-testid={asked.type === "permissionAsked" ? "permission-dock" : "question-dock"}
    data-asker={who === null ? "own" : "started"}
  >
    {#if asked.type === "permissionAsked"}
      {@const what = asks(asked, asked.call === null ? null : conversation.call(asked.call))}
      {@const command = wholeCommand(asked, what.shape)}
      {@const lines_ = change(asked)}
      {@const full = whole(asked, what)}
      {@const away = outside(asked)}
      {@const headAway = what.shape === "path" && what.object !== null && where(asked, what.object).where !== "inside"}
      {@const cutHead = what.object !== null && what.shape !== "command" && long(what.object)}
      <div class="what">
        <span class="ring"></span>
        <p>
          {@render asking(asked.parent)} asks to {@render pieces(what.lead)}{#if what.object !== null}{" "}{#if what.shape === "command"}{@const parts = lines(what.object)}<code
                class="exact"><Plain text={cut(parts.first)} /></code
              >{@render cutOff(parts.first)}{#if parts.rest > 0}<span class="also" data-testid="permission-more-lines"
                  >{" "}and {parts.rest} more {parts.rest === 1 ? "line" : "lines"}</span
                >{/if}{:else if what.shape === "path"}{@const at = where(asked, what.object)}{#if at.where !== "inside"}<span
                  class="warn"
                  data-testid="permission-outside">{AWAY[at.where]}</span
                >{" "}{/if}<code class="exact"><Plain text={cut(at.text)} /></code>{@render cutOff(at.text)}{:else}<code
                class="exact"><Plain text={cut(what.object)} /></code
              >{@render cutOff(what.object)}{@render leadsTo(what.object)}{/if}{/if}{@render awayCount(away, headAway)}{#if asked.truncated}<span
                  class="warn flow"
                  data-testid="permission-truncated"
                  >. The request is longer than the workbench can show, and its end is hidden</span
                >{/if}
        </p>
        {@render waiting()}
      </div>
      <!-- What the request holds scrolls under its line; the line and the
           choices stay in sight whatever it holds. -->
      <div class="body">
      {#each KINDS as kind (kind)}
        {@const these = away.filter((each) => each.where === kind && !(headAway && each.path === what.object))}
        {#if these.length > 0}
          <p class="away" data-testid="permission-outside-list">
            <span class="warn">{kind === "outside" ? "Outside the project:" : "Not plainly in the project:"}</span>
            {#each these as each, at (each.path)}{#if at > 0},{" "}{/if}<code class="exact"><Plain text={cut(each.path)} /></code
              >{/each}
          </p>
        {/if}
      {/each}
      {#if asked.description}
        <p class="description"><Plain text={cut(asked.description)} />{@render cutOff(asked.description)}</p>
      {/if}
      {#if command !== null || cutHead || lines_ !== null || full !== null}
        <div class="folds">
          {#if command !== null}
            <button class="reveal" tabindex="0" onclick={() => (shown = !shown)} aria-expanded={shown} data-testid="permission-command">
              <span class="chev" class:open={shown}><Icon name="chev" size={11} /></span>{asked.truncated
                ? "The command as far as it came"
                : "The whole command"}
            </button>
          {/if}
          {#if cutHead}
            <button class="reveal" tabindex="0" onclick={() => (showLong = !showLong)} aria-expanded={showLong} data-testid="permission-long">
              <span class="chev" class:open={showLong}><Icon name="chev" size={11} /></span>{asked.truncated
                ? "As far as it came"
                : what.shape === "path"
                  ? "The whole path"
                  : "All of it"}
            </button>
          {/if}
          {#if lines_ !== null}
            <button class="reveal" tabindex="0" onclick={() => (showChange = !showChange)} aria-expanded={showChange} data-testid="permission-details">
              <span class="chev" class:open={showChange}><Icon name="chev" size={11} /></span>The change
            </button>
          {/if}
          {#if full !== null}
            <button class="reveal" tabindex="0" onclick={() => (showWhole = !showWhole)} aria-expanded={showWhole} data-testid="permission-whole">
              <span class="chev" class:open={showWhole}><Icon name="chev" size={11} /></span>{asked.truncated
                ? "The request as far as it came"
                : "The whole request"}
            </button>
          {/if}
        </div>
        {#if command !== null && shown}
          <pre class="details exact"><Plain text={command} /></pre>
          {#if asked.truncated}<p class="warn flow cut-end">Cut short here: the rest did not reach the window.</p>{/if}
        {/if}
        {#if cutHead && showLong && what.object !== null}
          <pre class="details exact" data-testid="permission-long-text"><Plain text={what.object} /></pre>
          {#if asked.truncated}<p class="warn flow cut-end">Cut short here: the rest did not reach the window.</p>{/if}
        {/if}
        {#if lines_ !== null && showChange}
          <div class="details diff">
            {#each lines_ as line, at (at)}
              <div class="line {line.kind}"><span class="sign" aria-hidden="true"
                  >{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span
                ><Plain text={line.text} /></div>
            {/each}
          </div>
        {/if}
        {#if full !== null && showWhole}
          <pre class="details exact" data-testid="permission-whole-text"><Plain text={full} /></pre>
          {#if asked.truncated}<p class="warn flow cut-end" data-testid="permission-whole-cut">Cut short here: the rest did not reach the window.</p>{/if}
        {/if}
      {/if}
      </div>
      {#if denying !== null}
        <div class="deny">
          <input
            bind:value={words}
            onkeydown={onWordsKey}
            placeholder="Tell {named} why, or what to do instead (optional)"
            aria-label="Why the call is denied"
            data-testid="deny-words"
          />
          <button class="choice" tabindex="0" onclick={() => denying && choose(denying)} data-testid="deny-send">Deny</button>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="choices" onkeydown={(e) => onChoicesKey(e, asked.choices)}>
          {#each asked.choices as offer, at (offer.choice)}
            <button
              class="choice"
              class:primary={at === 0}
              tabindex={at === pointed ? 0 : -1}
              aria-disabled={takes(entry.request) ? undefined : "true"}
              data-choice={offer.choice}
              data-testid="choice-{offer.choice}"
              title={means(offer)}
              aria-describedby="means-{sessionKey}"
              onclick={() => choose(offer)}
              onfocus={() => (pointed = at)}
              onpointerenter={() => (pointed = at)}><span class="key">{at + 1}</span>{choiceLabel(offer)}</button
            >
          {/each}
        </div>
        {@const offer = asked.choices[pointed] ?? asked.choices[0]}
        <p class="means" id="means-{sessionKey}" data-testid="choice-means">
          {#if who === null || whoName === null}{choiceMeans(offer)}{:else}{@const said = choiceMeansIn(offer, whoName, who.where)}{said[0]}<Plain
              text={said[1]}
            />{said[2]}{/if}
        </p>
      {/if}
    {:else}
      {@const questions = asked.questions}
      <div class="what">
        <span class="ring"></span>
        <p>{@render asking(asked.parent)} asks you</p>
        {@render waiting()}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="questions" onkeydown={(e) => onQuestionKey(e, questions)}>
        <div class="body">
        {#each questions as question, at (at)}
          <div class="question" data-testid="question">
            <p class="ask">
              {#if question.header}<span class="chip"><Plain text={question.header} /></span>{/if}<Plain
                text={question.question}
              />
            </p>
            {#if question.options.length > 0}
              <!-- svelte-ignore a11y_interactive_supports_focus -->
              {@const now = direct(questions)}
              <div
                class="options"
                role={now ? "group" : question.multiple ? "group" : "radiogroup"}
                aria-label={markers(question.question)}
                onkeydown={onOptionsKey}
              >
                {#each question.options as option, index (option.label)}
                  {@const on = (picked[at] ?? []).includes(option.label)}
                  {#if now}
                    <button
                      class="option answer"
                      tabindex={index === 0 ? 0 : -1}
                      aria-disabled={takes(entry.request) ? undefined : "true"}
                      data-option
                      data-testid="question-option"
                      onclick={() => pick(at, option.label, false, questions)}
                    >
                      <span class="key">{index + 1}</span>
                      <span class="label"><Plain text={option.label} /></span>
                      {#if option.description}<span class="hint"><Plain text={option.description} /></span>{/if}
                    </button>
                  {:else}
                    <button
                      class="option"
                      class:on
                      role={question.multiple ? "checkbox" : "radio"}
                      aria-checked={on}
                      tabindex={index === 0 ? 0 : -1}
                      aria-disabled={takes(entry.request) ? undefined : "true"}
                      data-option
                      data-testid="question-option"
                      onclick={() => pick(at, option.label, question.multiple, questions)}
                    >
                      <span class="box" class:round={!question.multiple}>{#if on}<Icon name="check" size={10} />{/if}</span>
                      <span class="label"><Plain text={option.label} /></span>
                      {#if option.description}<span class="hint"><Plain text={option.description} /></span>{/if}
                    </button>
                  {/if}
                {/each}
              </div>
            {/if}
            {#if question.secret}
              <input
                type="password"
                autocomplete="off"
                spellcheck="false"
                bind:value={own[at]}
                placeholder="Type the answer; it is not shown"
                aria-label={markers(question.question)}
                data-testid="question-secret"
              />
            {:else if question.other}
              <input
                bind:value={own[at]}
                placeholder={question.options.length > 0 ? "Or answer in your own words" : "Your answer"}
                aria-label={markers(question.question)}
                data-testid="question-words"
              />
            {/if}
          </div>
        {/each}
        </div>
        <div class="actions">
          {#if !direct(questions) || (own[0] ?? "").trim() !== ""}
            <button
              class="choice primary"
              tabindex="0"
              disabled={answers(questions) === null}
              aria-disabled={takes(entry.request) ? undefined : "true"}
              onclick={() => send(questions)}
              data-testid="question-send">{direct(questions) ? "Send your answer" : "Answer"}</button
            >
          {/if}
          <button
            class="choice quiet"
            tabindex="0"
            aria-disabled={takes(entry.request) ? undefined : "true"}
            onclick={decline}
            data-testid="question-decline"
            >Don't answer</button
          >
        </div>
      </div>
    {/if}
    {#if entry.request.error !== null}
      <p class="error" data-testid="dock-error"><Plain text={entry.request.error} /></p>
    {/if}
  </div>
  {/if}
  {/key}
{/if}
</div>

<!-- Where an address leads: the host it goes to, said on its own since its
     start can look like another; the host another reader of it would go to
     when that is another; and what in it could mislead, in the warning
     colour. -->
{#snippet leadsTo(text: string)}{@const at = address(text)}{#if at !== null}<span data-testid="permission-host"
      >{" "}on <code class="exact"><Plain text={at.host} /></code></span
    >{#if at.other !== null}<span class="warn flow" data-testid="permission-host-other"
        >, or on <code class="exact"><Plain text={at.other} /></code> as some clients read it</span
      >{/if}{#if at.warnings.length > 0}<span class="warn flow" data-testid="permission-address-warn"
        >, and {at.warnings.join(" and ")}</span
      >{/if}{/if}{/snippet}

<!-- How many of a request's paths lie outside the project or not plainly
     in it, said on its line whenever the line itself does not already mark
     the one there is. -->
{#snippet awayCount(away: { where: "outside" | "unknown" }[], marked: boolean)}{@const out = away.filter((each) => each.where === "outside").length}{@const unsure = away.length - out}{#if away.length > (marked ? 1 : 0)}<span
      class="warn flow"
      data-testid="permission-away-count"
      >{#if out > 0}, with {out} {out === 1 ? "path" : "paths"} outside the project{/if}{#if unsure > 0}{out > 0 ? " and" : ", with"}
        {unsure} not plainly in it{/if}</span
    >{/if}{/snippet}

<!-- Who asks: this session's agent or a subagent of it, by its words; or a
     session it started, by its step and its name, and a subagent inside
     it by both. -->
{#snippet asking(parent: string | null)}{#if who === null}<b>{@render pieces(asker(parent))}</b>{@render cutOff(
      askerDescription(parent),
    )}{:else}{#if who.step !== null}<span class="steptag" data-testid="dock-step"><Plain text={who.step} /></span
      >{/if}{#if parent !== null}<b>{@render pieces(asker(parent))}</b>{@render cutOff(askerDescription(parent))}{" "}in{" "}{/if}<b
      data-testid="dock-session"><Plain text={whoName ?? ""} /></b
    >{@render cutOff(who.name)}{/if}{/snippet}

<!-- How many more wait, and from whom when it is one session; and, for a
     session this one started, the way to it. -->
{#snippet waiting()}{#if others.length > 0}<span
      class="more"
      title="{others.length} more waiting{next === null ? '' : `, from ${next}`}"
      data-testid="dock-more"
      >{others.length} more waiting{#if next !== null}, from <Plain text={next} />{/if}</span
    >{/if}{#if who !== null && entry?.kind !== "terminal"}<button class="go" tabindex="0" onclick={open} data-testid="dock-open"
      >Open</button
    >{/if}{/snippet}

<!-- What a cut leaves out, counted on the line. -->
{#snippet cutOff(text: string)}{#if leftOut(text) > 0}<span class="warn" data-testid="permission-cut"
      >{" "}and {leftOut(text)} more {leftOut(text) === 1 ? "character" : "characters"}</span
    >{/if}{/snippet}

<!-- Words the app says, and names the agent or a server gave, drawn as
     they are. -->
{#snippet pieces(lead: Piece[])}{#each lead as piece, at (at)}{#if typeof piece === "string"}{piece}{:else}<code
        class="exact name"><Plain text={piece.name} /></code
      >{/if}{/each}{/snippet}

<style>
  .hold {
    display: contents;
  }

  .dock {
    max-width: 740px;
    margin: 0 auto 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 10px;
    border-radius: calc(var(--radius) + 5px);
    box-shadow: inset 0 0 0 1px var(--accent);
    background: var(--clear-surface);
    font-size: var(--conv-small);
    color: var(--ink-2);
    max-height: 55vh;
    overflow: hidden;
  }

  .body {
    flex: 0 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .body:empty {
    display: none;
  }

  .what,
  .choices,
  .means,
  .deny,
  .actions,
  .error {
    flex: none;
  }

  .what {
    display: flex;
    align-items: baseline;
    gap: 9px;
    min-width: 0;
  }

  .what p {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .what b {
    color: var(--ink);
    font-weight: 600;
  }

  .ring {
    flex: none;
    align-self: flex-start;
    margin-top: calc((1lh - var(--dot)) / 2);
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.75px var(--accent);
  }

  .more {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--conv-fine);
    color: var(--accent);
  }

  /* The way to the session that asks, quiet beside what it asks. */
  .go {
    flex: none;
    margin: -1px 0;
    padding: 1px 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--conv-meta);
    color: var(--accent);
    white-space: nowrap;
    cursor: pointer;
  }

  .go:hover {
    background: var(--accent-soft);
  }

  .go:active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }

  /* The step a started session runs for, before its name. */
  .steptag {
    display: inline-block;
    margin-right: 7px;
    padding: 0 6px;
    border-radius: var(--radius-tag);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--label-size);
    line-height: 17px;
    vertical-align: 1px;
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
  }

  /* The prompt a round would start with, as the agent wrote it. */
  .prompt {
    margin: -2px 0 0 calc(var(--dot) + 9px);
    padding: 4px 8px;
    border-left: 2px solid var(--rule);
    background: var(--surface-2);
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  /* A request that takes no answer yet, settling in or with an answer on
     its way, says so by its controls fading. One that takes an answer
     shows them whole at once, so no control that answers is ever drawn
     faint. */
  .choice[aria-disabled="true"],
  .option[aria-disabled="true"] {
    opacity: 0.5;
    cursor: default;
    transition: opacity 0.2s;
  }

  .choice.plain {
    padding: 0 12px;
    max-width: 100%;
  }

  .choice .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  code {
    font: var(--conv-fine) var(--mono);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--ink);
  }

  .also {
    color: var(--ink-2);
    font-weight: 500;
    white-space: nowrap;
  }

  /* What the agent asks to run or touch reads left to right as one piece,
     whatever its characters would make of the text around it. */
  .exact {
    unicode-bidi: isolate;
    direction: ltr;
  }

  /* Said in the warning colour, so it reads as a caution and not a link. */
  .warn {
    color: var(--del);
    white-space: nowrap;
  }

  .cut-end {
    margin: -4px 0 0;
  }

  /* A warning of more than a few words flows with the line it ends. */
  .warn.flow {
    white-space: normal;
  }

  .away {
    margin: -4px 0 0 calc(var(--dot) + 9px);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .folds {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin-left: calc(var(--dot) + 5px);
  }

  .folds .reveal {
    margin-left: 0;
  }

  .description {
    margin: -4px 0 0 calc(var(--dot) + 9px);
    color: var(--ink-2);
  }

  .reveal {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: calc(var(--dot) + 5px);
    padding: 1px 4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    cursor: pointer;
  }

  .reveal:hover {
    color: var(--ink);
  }

  .chev {
    transition: transform 0.15s;
  }

  .chev.open {
    transform: rotate(90deg);
  }

  .details {
    margin: 0;
    max-height: 180px;
    overflow: auto;
    padding: 6px 10px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface-2);
    font: var(--conv-fine)/1.5 var(--mono);
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .details.diff {
    padding: 4px 0;
    white-space: pre;
  }

  .line {
    padding: 0 10px;
  }

  .sign {
    display: inline-block;
    width: 18px;
    text-align: center;
    user-select: none;
    -webkit-user-select: none;
  }

  /* The signs sit on their line's tint, so they lean toward the ink to
     stay readable on it in every palette. */
  .line.add .sign {
    color: color-mix(in srgb, var(--add) 80%, var(--ink));
  }

  .line.del .sign {
    color: color-mix(in srgb, var(--del) 80%, var(--ink));
  }

  .line.head {
    color: var(--ink-2);
    padding-left: 28px;
  }

  .line.add {
    background: color-mix(in srgb, var(--add) 14%, transparent);
  }

  .line.del {
    background: color-mix(in srgb, var(--del) 14%, transparent);
  }

  .choices,
  .actions,
  .deny {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .deny input {
    flex: 1;
    min-width: 180px;
  }

  .choice {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 11px 0 8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font: inherit;
    font-size: var(--conv-small);
    font-weight: 500;
    color: var(--ink);
    white-space: nowrap;
    cursor: pointer;
  }

  .actions .choice,
  .deny .choice {
    padding: 0 12px;
  }

  .choice:hover:not([aria-disabled="true"]) {
    background: var(--surface-2);
  }

  .choice.primary {
    background: var(--accent);
    box-shadow: none;
    color: var(--surface);
  }

  .choice.primary:hover:not([aria-disabled="true"]) {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink));
  }

  .choice.quiet {
    box-shadow: none;
    color: var(--ink-2);
  }

  .choice:active:not(:disabled, [aria-disabled="true"]) {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--ink-3);
  }

  .choice.primary:active:not(:disabled, [aria-disabled="true"]) {
    background: color-mix(in srgb, var(--accent) 78%, var(--ink));
  }

  .choice.primary:focus-visible {
    outline-offset: 2px;
  }

  .choice:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .key {
    display: inline-grid;
    place-items: center;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 4px;
    font-size: var(--label-size);
    font-variant-numeric: tabular-nums;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 35%, transparent);
    opacity: 1;
  }

  .means {
    margin: -2px 0 0;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .questions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }

  .questions > .body {
    gap: 10px;
  }

  .question {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ask {
    margin: 0;
    color: var(--ink);
    font-size: var(--conv-size);
  }

  .chip {
    display: inline-block;
    margin-right: 7px;
    padding: 0 6px;
    border-radius: var(--radius-tag);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--label-size);
    line-height: 17px;
    vertical-align: 1px;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .option {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }

  .option:hover:not([aria-disabled="true"]),
  .option.on {
    background: var(--accent-soft);
  }

  .option.answer {
    padding: 5px 8px;
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
  }

  .option.answer .key {
    align-self: center;
  }

  .options:has(.answer) {
    gap: 4px;
  }

  .box {
    flex: none;
    align-self: center;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--surface);
  }

  .box.round {
    border-radius: 50%;
  }

  .on .box {
    background: var(--accent);
    box-shadow: none;
  }

  .hint {
    color: var(--ink-2);
    font-size: var(--conv-meta);
  }

  input {
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font: inherit;
    font-size: var(--conv-small);
    color: var(--ink);
  }

  input:focus {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .error {
    margin: 0;
    font-size: var(--conv-meta);
    color: var(--del);
  }

  @media (prefers-reduced-motion: reduce) {
    .chev,
    .choice[aria-disabled="true"],
    .option[aria-disabled="true"] {
      transition: none;
    }
  }
</style>

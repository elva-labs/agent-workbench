<script lang="ts">
  import { tick } from "svelte";
  import type { Conversation, Request } from "$lib/conversation.svelte";
  import type { IntegratedEventBody, PermissionOffer } from "$lib/core";
  import { answer, reply } from "$lib/integrated.svelte";
  import { asks, choiceLabel, choiceMeans, inputPath, shortPath } from "$lib/thread";
  import Icon from "./Icon.svelte";

  /**
   * What the agent waits on the user for, docked over the composer rather
   * than in the thread: a permission, said in words, with the choices the
   * core offers, each saying what it keeps; or a question, with its options
   * and, where it takes them, room for the user's own words, a secret one
   * typed hidden. One at a time, the oldest first.
   *
   * The choices are one stop for the keyboard: the arrows move between
   * them, a digit picks one, and the first is the one that remembers
   * nothing. The dock never takes the keyboard by itself, so nothing typed
   * for something else answers it; Up from an empty composer reaches it.
   */
  interface Props {
    conversation: Conversation;
    sessionKey: string;
    agent: string;
    root: string | null;
    /** Called once an answer is on its way, for the keyboard to go back. */
    onAnswered?: () => void;
  }

  let { conversation, sessionKey, agent, root, onAnswered }: Props = $props();

  type Permission = Extract<IntegratedEventBody, { type: "permissionAsked" }>;
  type Question = Extract<IntegratedEventBody, { type: "questionAsked" }>;

  let request = $derived<Request | null>(conversation.open[0] ?? null);
  let more = $derived(Math.max(0, conversation.open.length - 1));

  let dock = $state<HTMLDivElement | null>(null);

  /** Who asks: the agent, or a subagent of it, by what it was asked to do. */
  function asker(parent: string | null): string {
    if (parent === null) return agent;
    const call = conversation.call(parent);
    const input = call?.input as Record<string, unknown> | null | undefined;
    const description = typeof input?.description === "string" ? input.description : null;
    return description === null ? `A subagent of ${agent}'s` : `The subagent for “${description}”`;
  }

  // ---- permissions ----

  /** The choice the help line speaks of: the one with the keyboard or the
      pointer, else the first. */
  let pointed = $state(0);
  /** Deny was picked, and waits for the user's words to go with it. */
  let denying = $state<PermissionOffer | null>(null);
  let words = $state("");

  $effect(() => {
    void request?.request;
    pointed = 0;
    denying = null;
    words = "";
    picked = [];
    own = [];
  });

  function choose(offer: PermissionOffer) {
    if (request === null || request.answering) return;
    if (offer.message && offer.choice === "deny" && denying === null) {
      denying = offer;
      void tick().then(() => dock?.querySelector<HTMLInputElement>("[data-testid='deny-words']")?.focus());
      return;
    }
    answer(sessionKey, request.request, offer.choice, offer.choice === "deny" ? words : undefined);
    onAnswered?.();
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

  /** What a permission is for, beyond its one line: an edit as the change
      it makes, a long command whole, anything else as the agent gave it. */
  function details(asked: Permission): { lines: { kind: "add" | "del" | "ctx"; text: string }[] } | { text: string } | null {
    const input = asked.input as Record<string, unknown> | null;
    if (input === null || typeof input !== "object") return null;
    if (asked.tool === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      return command.includes("\n") || command.length > 90 ? { text: command } : null;
    }
    if (asked.tool === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string")
      return {
        lines: [
          ...input.old_string.split("\n").map((text) => ({ kind: "del" as const, text })),
          ...input.new_string.split("\n").map((text) => ({ kind: "add" as const, text })),
        ],
      };
    if (asked.tool === "Write" && typeof input.content === "string")
      return { lines: input.content.split("\n").map((text) => ({ kind: "add" as const, text })) };
    if (asked.tool === "ExitPlanMode") return null;
    return { text: JSON.stringify(input, null, 2) };
  }

  let shown = $state(false);

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
      if (request === null || request.answering) return;
      reply(sessionKey, request.request, [[label]]);
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
    if (request === null || request.answering) return;
    const given = answers(questions);
    if (given === null) return;
    reply(sessionKey, request.request, given);
    onAnswered?.();
  }

  function decline() {
    if (request === null || request.answering) return;
    reply(sessionKey, request.request, null);
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

{#if request !== null}
  {@const asked = request.asked}
  <div
    class="dock"
    bind:this={dock}
    role="group"
    aria-label="{asker(asked.parent)} is waiting for you"
    data-testid={asked.type === "permissionAsked" ? "permission-dock" : "question-dock"}
  >
    {#if asked.type === "permissionAsked"}
      {@const what = asks(asked)}
      {@const more_ = details(asked)}
      <div class="what">
        <span class="ring"></span>
        <p>
          <b>{asker(asked.parent)}</b> asks to {what.verb}{#if what.object !== null}{" "}<code
              >{asked.tool === "Bash" ? what.object.split("\n")[0] : asked.path || inputPath(asked.input) ? shortPath(what.object, root) : what.object}</code
            >{/if}
        </p>
        {#if more > 0}<span class="more">{more} more waiting</span>{/if}
      </div>
      {#if asked.description}
        <p class="description">{asked.description}</p>
      {/if}
      {#if more_ !== null}
        <button class="reveal" onclick={() => (shown = !shown)} aria-expanded={shown} data-testid="permission-details">
          <span class="chev" class:open={shown}><Icon name="chev" size={11} /></span>{asked.tool === "Edit" || asked.tool === "Write" ? "The change" : "Details"}
        </button>
        {#if shown}
          {#if "text" in more_}
            <pre class="details">{more_.text}</pre>
          {:else}
            <div class="details diff">
              {#each more_.lines as line, at (at)}
                <div class="line {line.kind}">{line.text}</div>
              {/each}
            </div>
          {/if}
        {/if}
      {/if}
      {#if denying !== null}
        <div class="deny">
          <input
            bind:value={words}
            onkeydown={onWordsKey}
            placeholder="Tell {agent} why, or what to do instead (optional)"
            aria-label="Why the call is denied"
            data-testid="deny-words"
          />
          <button class="choice" onclick={() => denying && choose(denying)} data-testid="deny-send">Deny</button>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="choices" onkeydown={(e) => onChoicesKey(e, asked.choices)}>
          {#each asked.choices as offer, at (offer.choice)}
            <button
              class="choice"
              class:primary={at === 0}
              tabindex={at === pointed ? 0 : -1}
              disabled={request.answering}
              data-choice={offer.choice}
              data-testid="choice-{offer.choice}"
              title={choiceMeans(offer)}
              aria-describedby="means-{sessionKey}"
              onclick={() => choose(offer)}
              onfocus={() => (pointed = at)}
              onpointerenter={() => (pointed = at)}><span class="key">{at + 1}</span>{choiceLabel(offer)}</button
            >
          {/each}
        </div>
        <p class="means" id="means-{sessionKey}" data-testid="choice-means">
          {choiceMeans(asked.choices[pointed] ?? asked.choices[0])}
        </p>
      {/if}
    {:else}
      {@const questions = asked.questions}
      <div class="what">
        <span class="ring"></span>
        <p><b>{asker(asked.parent)}</b> asks you</p>
        {#if more > 0}<span class="more">{more} more waiting</span>{/if}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="questions" onkeydown={(e) => onQuestionKey(e, questions)}>
        {#each questions as question, at (at)}
          <div class="question" data-testid="question">
            <p class="ask">
              {#if question.header}<span class="chip">{question.header}</span>{/if}{question.question}
            </p>
            {#if question.options.length > 0}
              <!-- svelte-ignore a11y_interactive_supports_focus -->
              {@const now = direct(questions)}
              <div
                class="options"
                role={now ? "group" : question.multiple ? "group" : "radiogroup"}
                aria-label={question.question}
                onkeydown={onOptionsKey}
              >
                {#each question.options as option, index (option.label)}
                  {@const on = (picked[at] ?? []).includes(option.label)}
                  {#if now}
                    <button
                      class="option answer"
                      tabindex={index === 0 ? 0 : -1}
                      disabled={request.answering}
                      data-option
                      data-testid="question-option"
                      onclick={() => pick(at, option.label, false, questions)}
                    >
                      <span class="key">{index + 1}</span>
                      <span class="label">{option.label}</span>
                      {#if option.description}<span class="hint">{option.description}</span>{/if}
                    </button>
                  {:else}
                    <button
                      class="option"
                      class:on
                      role={question.multiple ? "checkbox" : "radio"}
                      aria-checked={on}
                      tabindex={index === 0 ? 0 : -1}
                      disabled={request.answering}
                      data-option
                      data-testid="question-option"
                      onclick={() => pick(at, option.label, question.multiple, questions)}
                    >
                      <span class="box" class:round={!question.multiple}>{#if on}<Icon name="check" size={10} />{/if}</span>
                      <span class="label">{option.label}</span>
                      {#if option.description}<span class="hint">{option.description}</span>{/if}
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
                aria-label={question.question}
                data-testid="question-secret"
              />
            {:else if question.other}
              <input
                bind:value={own[at]}
                placeholder={question.options.length > 0 ? "Or answer in your own words" : "Your answer"}
                aria-label={question.question}
                data-testid="question-words"
              />
            {/if}
          </div>
        {/each}
        <div class="actions">
          {#if !direct(questions) || (own[0] ?? "").trim() !== ""}
            <button
              class="choice primary"
              disabled={request.answering || answers(questions) === null}
              onclick={() => send(questions)}
              data-testid="question-send">{direct(questions) ? "Send your answer" : "Answer"}</button
            >
          {/if}
          <button class="choice quiet" disabled={request.answering} onclick={decline} data-testid="question-decline"
            >Don't answer</button
          >
        </div>
      </div>
    {/if}
    {#if request.error !== null}
      <p class="error" data-testid="dock-error">{request.error}</p>
    {/if}
  </div>
{/if}

<style>
  .dock {
    max-width: 740px;
    margin: 0 auto 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 10px;
    border-radius: calc(var(--radius) + 5px);
    box-shadow: inset 0 0 0 1px var(--accent);
    background: var(--surface);
    font-size: 12.5px;
    color: var(--ink-2);
    max-height: 55vh;
    overflow: auto;
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
    align-self: center;
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.75px var(--accent);
  }

  .more {
    flex: none;
    font-size: 11.5px;
    color: var(--accent);
  }

  code {
    font: 11.5px var(--mono);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--ink);
  }

  .description {
    margin: -4px 0 0 calc(var(--dot) + 9px);
    color: var(--ink-3);
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
    font-size: 12px;
    color: var(--ink-3);
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
    font: 11.5px/1.5 var(--mono);
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
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ink);
    white-space: nowrap;
    cursor: pointer;
  }

  .actions .choice,
  .deny .choice {
    padding: 0 12px;
  }

  .choice:hover {
    background: var(--surface-2);
  }

  .choice.primary {
    background: var(--accent);
    box-shadow: none;
    color: var(--bg);
  }

  .choice.primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink));
  }

  .choice.quiet {
    box-shadow: none;
    color: var(--ink-2);
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
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 35%, transparent);
    opacity: 0.75;
  }

  .means {
    margin: -2px 0 0;
    font-size: 12px;
    color: var(--ink-3);
    overflow-wrap: anywhere;
  }

  .questions {
    display: flex;
    flex-direction: column;
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
    font-size: 13px;
  }

  .chip {
    display: inline-block;
    margin-right: 7px;
    padding: 0 6px;
    border-radius: var(--radius-tag);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11px;
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

  .option:hover,
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
    color: var(--bg);
  }

  .box.round {
    border-radius: 50%;
  }

  .on .box {
    background: var(--accent);
    box-shadow: none;
  }

  .hint {
    color: var(--ink-3);
    font-size: 12px;
  }

  input {
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font: inherit;
    font-size: 12.5px;
    color: var(--ink);
  }

  input:focus {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--del);
  }

  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>

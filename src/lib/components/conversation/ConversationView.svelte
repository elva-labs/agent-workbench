<script lang="ts">
  import { agentProfile } from "$lib/agent.svelte";
  import { dirFor } from "$lib/accounts.svelte";
  import { aloneOn, linkFor, resume, trust, unspoken } from "$lib/integrated.svelte";
  import { stepsGist, workflows } from "$lib/workflows.svelte";
  import { close, resumeWithout, type Session } from "$lib/sessions.svelte";
  import { senderOf } from "$lib/senders.svelte";
  import { spoken } from "$lib/instructions";
  import { notRead } from "$lib/thread";
  import { projectLabel, sessionRoot } from "$lib/workspace.svelte";
  import { mentionOpener } from "$lib/show.svelte";
  import { unsent } from "$lib/mention";
  import { mentionsOf } from "$lib/mentioned.svelte";
  import { answerable, dockedFor } from "$lib/docked.svelte";
  import { markCall, shownCall, takeCall } from "$lib/callShown.svelte";
  import { foldKey, locate } from "$lib/thread";
  import type { Message } from "$lib/conversation.svelte";
  import Composer from "./Composer.svelte";
  import Dock from "./Dock.svelte";
  import FindBar from "./FindBar.svelte";
  import Icon from "./Icon.svelte";
  import Thread from "./Thread.svelte";
  import Plain from "./Plain.svelte";
  import { tick, untrack } from "svelte";
  import { layout, overlayHoldsKeyboard } from "$lib/layout.svelte";

  /**
   * What the agent pane draws for an integrated session in place of a
   * terminal: the thread, and under it what the user does next. Before the
   * session can run it may need the user: a folder to trust, or a sign-in
   * the user does in a terminal. A session that ended or could not start
   * says why and offers to start again.
   */
  interface Props {
    session: Session;
    /** The session on screen in the pane. */
    active: boolean;
  }

  let { session, active }: Props = $props();

  let link = $derived(linkFor(session.key));
  let conversation = $derived(link.conversation);
  let profile = $derived(agentProfile(session.agent));
  let agent = $derived(profile.product);
  let folder = $derived(session.startIn ?? session.project);

  let dock = $state<Dock | null>(null);
  let thread = $state<Thread | null>(null);
  /** The find bar stands over the thread. */
  let finding = $state(false);
  /** What waits in the dock: the session's own requests and those of the
      sessions it started. */
  let docked = $derived(dockedFor(session.key));
  /** The agent's own name, as the one who speaks and asks. */
  let name = $derived(profile.name);

  /** A message that was not delivered goes back to be sent again. One the
      agent dropped stays in the thread, where it happened; one that never
      reached it leaves the thread for the composer. */
  function putBack(message: Message) {
    const back = unsent(spoken(message.text, senderOf(message) === null).text, mentionsOf(message.id));
    const text = back.draft;
    link.draft = link.draft.trim() === "" ? text : `${text}\n${link.draft}`;
    link.mentions = [...new Set([...link.mentions, ...back.picked])];
    link.images = [...message.images, ...link.images];
    if (!message.placed) conversation.forget(message.id);
    queueMicrotask(() =>
      document
        .querySelector<HTMLTextAreaElement>(`[data-session="${session.key}"] [data-testid="composer-input"]`)
        ?.focus(),
    );
  }

  /** The keyboard on the dock, when something waits there. */
  function toDock(): boolean {
    if (docked.length === 0 || dock === null) return false;
    dock.focus();
    return true;
  }

  /** Once an answer is on its way the keyboard goes back to the composer. */
  function answered() {
    queueMicrotask(() => {
      const field = document.querySelector<HTMLTextAreaElement>(
        `[data-session="${session.key}"] [data-testid="composer-input"]`,
      );
      if (docked.length > 0) dock?.focus();
      else field?.focus();
    });
  }

  let view = $state<HTMLDivElement | null>(null);

  // A call this session is to be opened at, once it is on screen: the call
  // comes into view with the folds around it and the call itself open, and
  // is marked for a moment.
  $effect(() => {
    shownCall.asked;
    if (!active || thread === null || shownCall.key !== session.key) return;
    untrack(() => void openAt(takeCall(session.key)));
  });

  async function openAt(id: string | null) {
    const call = id === null ? null : conversation.call(id);
    const where = id === null ? null : locate(conversation, id);
    if (call === null || where === null || where.entry === null || thread === null) return;
    for (const fold of [...where.folds, foldKey("step", call)]) conversation.opened.add(fold);
    await tick();
    // The call's own row in the middle of the view, the thread no longer
    // following its foot, so what the run goes on to say leaves it there.
    await thread.reveal(where.entry, "center", `[data-call="${CSS.escape(call.call)}"] > [data-testid='step-head']`);
    markCall(call.call);
  }

  // With no composer to type in, the keyboard goes where the next step is:
  // Resume once the session is over, the card that asks before it can run.
  // A card is read before its buttons are reached, so it takes the keyboard
  // itself rather than its first choice.
  $effect(() => {
    layout.focusRequest;
    const where = link.untrusted
      ? "[data-testid='trust-gate'] .card"
      : conversation.notLoggedIn
        ? "[data-testid='login-gate'] .card"
        : over
          ? "[data-testid='resume-session'], [data-testid='resume-without-workflow']"
          : null;
    if (where === null || !active || layout.focus !== "agent") return;
    untrack(() => {
      void tick().then(() => {
        if (view === null || overlayHoldsKeyboard()) return;
        const owner = document.activeElement;
        if (owner !== null && owner !== document.body && view.contains(owner) && owner.matches("button, input, textarea"))
          return;
        view.querySelector<HTMLElement>(where)?.focus();
      });
    });
  });

  let over = $derived(
    session.status === "exited" || session.status === "crashed" || session.status === "failed",
  );

  let intro = $derived(
    session.status === "starting"
      ? `Starting ${agent}…`
      : session.resumedFrom === null
        ? session.workflow === null
          ? `A new ${agent} session in ${projectLabel(session.project)}, with your login, settings, hooks and tools.`
          : `A new ${agent} session in ${projectLabel(session.project)}, following ${session.workflow.name}. It directs; ${stepsGist(session.workflow)}.`
        : conversation.earlier === "read"
          ? "No earlier messages were found for this session."
          : `This session was resumed. Its earlier messages ${notRead(conversation.earlierWhy)}`,
  );

  /** Nothing has been said in it yet, so its workflow can still be
      chosen, where there is a workflow to choose or one to leave. */
  let choosable = $derived(unspoken(session) && (workflows.list.length > 0 || session.workflow !== null));

  /** Why the session is over, in a sentence. */
  let why = $derived.by(() => {
    // The workflow it followed is lost: the error says so, and what to do.
    if (session.workflowLost !== null && session.error !== null) return session.error;
    if (session.status === "failed") return `${agent} could not start: ${session.error ?? "no reason was given"}.`;
    const said = conversation.errors.filter((error) => error.kind !== "notLoggedIn").at(-1);
    if (session.status === "exited") return "The session ended.";
    if (said !== undefined) return `The session stopped: ${said.message}.`;
    return session.exitCode === null
      ? "The session stopped."
      : `The session stopped with code ${session.exitCode}.`;
  });

  /** How the user signs in, for an account of their own. */
  let signIn = $derived.by(() => {
    const dir = dirFor(session.account, session.agent);
    return dir === undefined ? profile.signIn : `${profile.configVar}=${dir} ${profile.signIn}`;
  });
</script>

<div class="conv" class:active bind:this={view} data-testid="conversation" data-session={session.key}>
  {#if link.untrusted}
    <div class="gate" data-testid="trust-gate">
      <div class="card" tabindex="-1" role="group" aria-labelledby="gate-{session.key}">
        <span class="badge"><Icon name="lock" size={16} /></span>
        <h2 id="gate-{session.key}">Trust this folder?</h2>
        <p>
          {agent} has not been told that the files in <code>{folder}</code> can be trusted. A trusted
          folder's settings can run hooks and MCP servers on this machine, so trust it only if you know
          where its files came from.
        </p>
        <div class="buttons">
          <button class="primary" tabindex="0" disabled={link.busy} onclick={() => trust(session.key)} data-testid="trust-folder"
            >Trust and start</button
          >
          <button tabindex="0" onclick={() => close(session.key)} data-testid="trust-not-now">Not now</button>
        </div>
      </div>
    </div>
  {:else if conversation.notLoggedIn}
    <div class="gate" data-testid="login-gate">
      <div class="card" tabindex="-1" role="group" aria-labelledby="gate-{session.key}">
        <span class="badge"><Icon name="lock" size={16} /></span>
        <h2 id="gate-{session.key}">{agent} is not signed in</h2>
        <p>
          Sign in by running <code>{signIn}</code> in a terminal and following its steps, then start the
          session again. The workbench never signs in for you.
        </p>
        <div class="buttons">
          <button class="primary" tabindex="0" disabled={link.busy} onclick={() => resume(session.key)} data-testid="login-retry"
            >Try again</button
          >
        </div>
      </div>
    </div>
  {:else}
    <FindBar bind:open={finding} {conversation} {thread} root={folder} {active} host={view} />
    <Thread
      bind:this={thread}
      room={finding ? 28 : 0}
      {conversation}
      root={folder}
      {intro}
      agent={name}
      models={profile.turnModels}
      onPutBack={putBack}
      sender={(message) => senderOf(message)}
      opener={(path) => mentionOpener(session.key, path)}
    />
    <div class="foot">
      {#if over}
        <div class="ended" data-testid="session-ended">
          <span class="why"><Plain text={why} /></span>
          {#if session.workflowLost !== null}
            <!-- The workflow this session followed is gone with its copy:
                 going on without one is the user's to say. -->
            <button class="primary" tabindex="0" disabled={link.busy} onclick={() => resumeWithout(session.key)} data-testid="resume-without-workflow"
              >Resume without a workflow</button
            >
          {:else}
            <button class="primary" tabindex="0" disabled={link.busy} onclick={() => resume(session.key)} data-testid="resume-session"
              >{session.status === "failed" ? "Try again" : "Resume"}</button
            >
          {/if}
        </div>
      {:else}
        <Dock bind:this={dock} sessionKey={session.key} agent={name} {active} onAnswered={answered} />
        <Composer
          sessionKey={session.key}
          {conversation}
          agent={name}
          ready={session.status === "running" && (link.handle !== null || link.restarting)}
          {active}
          onDock={toDock}
          answers={docked.some(answerable)}
          defaultModel={session.model === null}
          slash={profile.commands}
          root={sessionRoot(session)}
          dir={session.cwd ?? folder}
          project={projectLabel(session.project)}
          agentId={session.agent}
          alone={agentProfile(aloneOn(session)).name}
          workflow={session.workflow}
          {choosable}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .conv {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    visibility: hidden;
    background: var(--surface);
    font-family: var(--chrome);
    container: conversation / inline-size;
    /* The conversation's type scale, from the look's own sizes: what is
       said, what goes beside it, what notes it, and the finest print. */
    --conv-size: 13.5px;
    --conv-small: var(--row-size);
    --conv-meta: var(--meta-size);
    --conv-fine: calc(var(--meta-size) - 0.5px);
  }

  @container conversation (max-width: 520px) {
    .conv .foot {
      padding: 0 14px 12px;
    }
  }

  :global(:root:not([data-look="modern"])) .conv {
    --conv-size: 12.5px;
  }

  .conv.active {
    visibility: visible;
  }

  .foot {
    flex: none;
    padding: 0 24px 14px;
  }

  .ended {
    max-width: 740px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px 9px 14px;
    border-radius: calc(var(--radius) * 2);
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
    font-size: var(--conv-small);
    color: var(--ink-2);
  }

  .why {
    flex: 1;
    min-width: 0;
  }

  .gate {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow: auto;
  }

  .card {
    max-width: 440px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 20px 22px;
    border-radius: calc(var(--radius) * 2);
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
  }

  .card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .badge {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: calc(var(--radius) * 4);
    background: var(--accent-soft);
    color: var(--accent);
  }

  h2 {
    margin: 0;
    font-size: calc(var(--conv-size) + 0.5px);
    font-weight: 600;
    color: var(--ink);
  }

  .card p {
    margin: 0;
    font-size: var(--conv-small);
    line-height: 1.55;
    color: var(--ink-2);
  }

  code {
    font-family: var(--mono);
    font-size: var(--conv-fine);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  button {
    height: 28px;
    padding: 0 12px;
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

  button:hover {
    background: var(--surface-2);
  }

  button.primary {
    background: var(--accent);
    box-shadow: none;
    color: var(--surface);
  }

  button.primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, var(--ink));
  }

  button:active:not(:disabled) {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--ink-3);
  }

  button.primary:active:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 78%, var(--ink));
  }

  button.primary:focus-visible {
    outline-offset: 2px;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>

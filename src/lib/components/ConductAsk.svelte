<script lang="ts">
  import { coversBrowser } from "$lib/browser.svelte";
  import { accountWords, allow, conductor, once, refuse, roundQuestion } from "$lib/conductor.svelte";
  import { returnFocus } from "$lib/layout.svelte";
  import { roundDockedIn } from "$lib/docked.svelte";
  import Plain from "$lib/components/conversation/Plain.svelte";

  let ask = $derived(conductor.asking);
  /** A round past the limit docks in its integrated session while that is
      on screen, and is asked here otherwise. */
  let docked = $derived(roundDockedIn() !== null);

  /** The buttons go with the question, and with them the keyboard the click
      gave them: the pane that has the focus state takes it back. */
  function answer(choose: () => void) {
    choose();
    returnFocus();
  }
</script>

{#if ask !== null && ask.round !== null}
  <!-- A round of review past what the workflow gives a piece: the user's
       yes lets this one through. -->
  {#if !docked}
  <div class="ask" data-card role="alertdialog" aria-label="Another round of review" use:coversBrowser data-testid="conduct-ask">
    <p class="title">{ask.caller} wants another round of {ask.round.step}</p>
    <p class="where">
      In {ask.project}{ask.worktree ? ", in a worktree of its own" : ""}.
      {#if ask.named !== null}
        <span data-testid="conduct-account">{accountWords(ask.named)}</span>
      {/if}
      <span data-testid="conduct-round">{roundQuestion(ask.round)}</span>
    </p>
    {#if ask.prompt !== ""}<p class="prompt">{ask.prompt}</p>{/if}
    <div class="actions">
      <button class="go" onclick={() => answer(once)} data-testid="conduct-allow-round">Allow one more round</button>
      <button class="later" onclick={() => answer(refuse)} data-testid="conduct-no">Stop at the limit</button>
    </div>
  </div>
  {/if}
{:else if ask !== null}
  <div
    class="ask"
    data-card
    role="alertdialog"
    aria-label="Start a session"
    aria-describedby={ask.outside !== null ? "conduct-ask-title conduct-ask-outside" : "conduct-ask-title"}
    use:coversBrowser
    data-testid="conduct-ask"
  >
    <p class="title" id="conduct-ask-title">{ask.caller} wants to start a session</p>
    {#if ask.outside !== null}
      <!-- A call that names no session: the workbench cannot tell which
           agent makes it, so each start it asks for is asked about. -->
      <p class="where" id="conduct-ask-outside" data-testid="conduct-outside">
        It runs in {ask.outside} and does not say which session it is: an agent run outside the workbench, or a session
        that left its name out. Each new session it asks for is put to you.
      </p>
    {/if}
    {#if ask.outside !== ask.project}
      <p class="where">
        In {ask.project}{ask.worktree ? ", in a worktree of its own" : ""}.
        {#if ask.named !== null}
          <span data-testid="conduct-account">{accountWords(ask.named)}</span>
        {/if}
      </p>
    {:else if ask.worktree || ask.named !== null}
      <!-- The folder it runs in is the project, said just above. -->
      <p class="where">
        {ask.worktree ? "In a worktree of its own." : ""}
        {#if ask.named !== null}
          <span data-testid="conduct-account">{accountWords(ask.named)}</span>
        {/if}
      </p>
    {/if}
    <p class="prompt"><Plain text={ask.prompt} /></p>
    <div class="actions">
      {#if ask.once}
        <button class="go" onclick={() => answer(once)} data-testid="conduct-once">Allow once</button>
      {:else}
        <button class="go" onclick={() => answer(allow)} data-testid="conduct-allow">Allow this session</button>
        <button class="later" onclick={() => answer(once)} data-testid="conduct-once">Once</button>
      {/if}
      <button class="later" onclick={() => answer(refuse)} data-testid="conduct-no">No</button>
    </div>
  </div>
{/if}

<style>
  /* Over the agent pane, near the top, where the question is read before
     the terminal under it, and over a peeked sessions pane. */
  .ask {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 7;
    width: min(420px, calc(100vw - 48px));
    padding: 10px 12px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
  }

  /* Where the cards let a background through, the second surface is a
     fill let through, laid over the card's paint so the ask still covers
     what is under it. */
  :global(:root[data-cards]) .ask {
    background: linear-gradient(var(--surface-2), var(--surface-2)), var(--paint-surface);
  }

  .title {
    margin: 0 0 4px;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--accent);
  }

  .where {
    margin: 0 0 8px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .prompt {
    margin: 0 0 10px;
    padding: 6px 8px;
    border-left: 2px solid var(--rule);
    background: var(--paint-surface);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .actions button {
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
</style>

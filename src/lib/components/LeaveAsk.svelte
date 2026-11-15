<script lang="ts">
  /**
   * The question before the window closes or the app quits while sessions
   * run or the editor holds unsaved edits. It says what goes: how many
   * sessions stop, how many of them wait on the user, and every unsaved
   * file. It is drawn over the whole window, whatever the panes under it
   * show, and tells the core it is up from here, once it is on the page:
   * the core takes that as the question being in front of the user, and
   * lets the window go when it does not hear it. Cancel has the keyboard.
   */
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import { core } from "$lib/core";
  import {
    editor,
    leaveCancelled,
    leaveWithoutSaving,
    saveAllAndLeave,
    unsavedNames,
  } from "$lib/editor.svelte";
  import { running, runningAside, runningQuestion } from "$lib/leaving.svelte";

  let ask = $derived(editor.asking?.kind === "leave" ? editor.asking : null);
  let names = $derived(ask === null ? [] : unsavedNames());
  let live = $derived(running());
  let busy = $derived(ask === null ? null : runningQuestion(ask.leave, live));

  /** Says the question numbered `generation` is on the page: each time a
      new one is drawn, a close asked again while it is up included. */
  function heard(node: HTMLElement, generation: number) {
    const tell = (number: number) => {
      if (node.isConnected) void core().leaveHeard(number).catch(() => {});
    };
    tell(generation);
    return { update: tell };
  }
</script>

{#if ask !== null}
  <div class="leave" use:coversBrowser use:heard={ask.generation} data-testid="leave-ask">
    {#if names.length > 0}
      <ConfirmStrip
        question={ask.leave === "quit" ? "Quit with unsaved edits?" : "Close the window with unsaved edits?"}
        detail="{names.length === 1 ? '1 file has' : `${names.length} files have`} edits not yet saved: {names.join(', ')}.{runningAside(live)}"
        action={ask.leave === "quit" ? "Quit without saving" : "Close without saving"}
        alternative={{
          label: ask.leave === "quit" ? "Save all and quit" : "Save all and close",
          onClick: () => void saveAllAndLeave(),
        }}
        safe
        onConfirm={leaveWithoutSaving}
        onCancel={leaveCancelled}
        testid="close-window"
      />
    {:else if busy !== null}
      <ConfirmStrip
        question={busy.question}
        detail={busy.detail}
        action={busy.action}
        onConfirm={leaveWithoutSaving}
        onCancel={leaveCancelled}
        testid="close-window"
      />
    {/if}
  </div>
{/if}

<style>
  /* Over every pane, near the top, where it is read before anything under
     it: a card on the surface, the strip inside it. */
  .leave {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    width: min(560px, calc(100vw - 48px));
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 16px 48px color-mix(in srgb, black 30%, transparent);
  }
</style>

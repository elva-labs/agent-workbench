<script lang="ts">
  import Icon from "./Icon.svelte";

  /**
   * A quiet run mark after a command the agent wrote for the user to run,
   * a code span or a line of a code block that begins with `!` and a
   * space. A click runs the command in the session's folder as if the user
   * had typed it in the composer, and leaves the draft as it is; each click
   * runs it again. It is an item of the thread's arrow walk, takes no focus
   * from a press, and holds no text, so the code it stands in copies as
   * written.
   */
  interface Props {
    /** The command, without its `!`. */
    command: string;
    onrun: (command: string) => void;
  }

  let { command, onrun }: Props = $props();
</script>

<button
  class="run"
  tabindex="-1"
  data-thread-item
  data-find-skip
  aria-label="Run {command}"
  title="Run {command}"
  onmousedown={(e) => e.preventDefault()}
  onclick={() => onrun(command)}
  data-testid="run-command"
><Icon name="run" size={12} /></button>

<style>
  .run {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin: -2px 0 0 3px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    vertical-align: middle;
    color: var(--ink-3);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }

  .run:hover,
  .run:focus-visible {
    color: var(--accent);
    background: var(--accent-soft);
  }
</style>

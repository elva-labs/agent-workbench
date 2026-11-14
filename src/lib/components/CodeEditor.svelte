<script lang="ts">
  /**
   * The editor itself: one CodeMirror view, showing the buffer of the tab in
   * front. Switching tabs swaps the buffer's state in, with its text, its
   * selection and its history, and puts back where it was scrolled to.
   */
  import { onMount, untrack } from "svelte";
  import { EditorSelection } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { stateFor } from "$lib/codeEditor";
  import {
    attachView,
    editor,
    editorShows,
    scrollOf,
    stateOf,
  } from "$lib/editor.svelte";
  import { layout, overlayHoldsKeyboard } from "$lib/layout.svelte";

  interface Props {
    /** The buffer to show. */
    buffer: string;
  }

  let { buffer }: Props = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  let showing: string | null = null;

  onMount(() => {
    view = new EditorView({ parent: host, state: stateFor("") });
    attachView(view);
    show(buffer);
    return () => {
      editorShows(null, place());
      attachView(null);
      view?.destroy();
      view = null;
      showing = null;
    };
  });

  function place() {
    return view === null ? undefined : { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
  }

  function show(key: string) {
    if (view === null || showing === key) return;
    const state = stateOf(key);
    if (state === null) return;
    editorShows(key, showing === null ? undefined : place());
    showing = key;
    view.setState(state);
    const scroll = scrollOf(key);
    if (scroll !== null) {
      // Laid out first, so the scroll has somewhere to go.
      requestAnimationFrame(() => {
        if (view === null || showing !== key) return;
        view.scrollDOM.scrollTop = scroll.top;
        view.scrollDOM.scrollLeft = scroll.left;
      });
    }
    revealIfAsked();
  }

  $effect(() => {
    const key = buffer;
    untrack(() => show(key));
  });

  /** A place asked for: the cursor on it, the range selected, and the line
      brought to the middle. */
  function revealIfAsked() {
    const asked = editor.reveal;
    if (view === null || asked === null || asked.key !== showing) return;
    editor.reveal = null;
    const doc = view.state.doc;
    const first = doc.line(Math.min(Math.max(1, asked.from), doc.lines));
    const last = doc.line(Math.min(Math.max(asked.from, asked.to), doc.lines));
    const range =
      asked.to > asked.from
        ? EditorSelection.range(first.from, last.to)
        : EditorSelection.cursor(first.from);
    view.dispatch({
      selection: range,
      effects: EditorView.scrollIntoView(first.from, { y: "center" }),
    });
  }

  $effect(() => {
    editor.reveal;
    untrack(revealIfAsked);
  });

  // The files pane asked for the keyboard and it belongs here: a focus
  // chord, the editor's own tab clicked, a dialog giving the keyboard back.
  $effect(() => {
    layout.focusRequest;
    untrack(() => {
      if (view === null || layout.focus !== "changes" || editor.target !== "editor") return;
      // Anything inside the editor, its find panel included, keeps it.
      if (overlayHoldsKeyboard() || view.dom.contains(document.activeElement)) return;
      view.focus();
    });
  });
</script>

<div
  class="code"
  bind:this={host}
  style:--editor-size="{editor.size}px"
  onfocusin={() => (editor.target = "editor")}
  data-testid="code-editor"
></div>

<style>
  .code {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .code :global(.cm-editor) {
    flex: 1;
    min-height: 0;
  }
</style>

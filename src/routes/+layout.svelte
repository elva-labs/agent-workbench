<script lang="ts">
  import "@fontsource/ibm-plex-sans/400.css";
  import "@fontsource/ibm-plex-sans/500.css";
  import "@fontsource/ibm-plex-sans/600.css";
  import "@fontsource/ibm-plex-mono/400.css";
  import "@fontsource/ibm-plex-mono/400-italic.css";
  import "@fontsource/ibm-plex-mono/500.css";
  import "@fontsource/ibm-plex-mono/700.css";
  import "@fontsource/ibm-plex-mono/700-italic.css";
  import "@fontsource/inter/400.css";
  import "@fontsource/inter/500.css";
  import "@fontsource/inter/600.css";
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/400-italic.css";
  import "@fontsource/jetbrains-mono/500.css";
  import "@fontsource/jetbrains-mono/700.css";
  import "@fontsource/jetbrains-mono/700-italic.css";
  import "@fontsource/archivo/600.css";
  import "@fontsource/archivo/700.css";
  import "$lib/styles/tokens.css";
  import "$lib/styles/palettes.css";
  import "$lib/styles/fonts.css";
  import "$lib/styles/looks.css";

  import { onMount } from "svelte";
  import { loadTheme } from "$lib/theme.svelte";
  import { loadKeys } from "$lib/keys.svelte";
  import { loadHooks, startChecks } from "$lib/hook.svelte";
  import { followSettings } from "$lib/preferences.svelte";
  import { loadUserStyles } from "$lib/userStyles.svelte";
  import { loadLayout } from "$lib/layout.svelte";
  import { loadStarted, watchStops } from "$lib/conductor.svelte";
  import { loadRemembered } from "$lib/sessions.svelte";
  import { reopen } from "$lib/reopen.svelte";
  import { followOpenRequests, restore, workspace } from "$lib/workspace.svelte";

  let { children } = $props();

  onMount(() => {
    // The window's own copies first, so the first frame is painted as the
    // last one was; the core's settings follow as soon as it answers. The
    // hooks are read before the workspace is, which is what tells a fresh
    // install from a setup that predates the hooks choice.
    loadTheme();
    loadKeys();
    loadHooks();
    loadUserStyles();
    loadLayout();
    loadRemembered();
    loadStarted();
    const stopStops = watchStops();
    let closed = false;
    let stopSettings = () => {};
    void followSettings().then((stop) => {
      if (closed) stop();
      else stopSettings = stop;
    });
    // The sessions that were open come back into the projects that are, and
    // only then are the folders asked for from outside opened in front.
    let stopReopen = () => {};
    const restored = restore().then(() => {
      if (!closed) stopReopen = reopen();
    });
    // The projects the window opened with are asked about once, together.
    const startHooks = () => startChecks(workspace.open.map((project) => project.path));
    void restored.then(startHooks, startHooks);
    const stopOpening = followOpenRequests(restored);
    return () => {
      closed = true;
      stopSettings();
      stopStops();
      stopOpening();
      stopReopen();
    };
  });
</script>

{@render children()}

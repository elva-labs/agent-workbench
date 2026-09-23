<script lang="ts">
  import { conductor } from "$lib/conductor.svelte";
  import { settings } from "$lib/settings.svelte";
  import { settingsAsk } from "$lib/settingsTools.svelte";
  import { theme } from "$lib/theme.svelte";
  import { paintStyles, userStyles } from "$lib/userStyles.svelte";

  /**
   * Lays the user's stylesheet over the app's while it is on, and takes it
   * off while the app asks the user something or the settings are open, so
   * a question always reads as the app's own. Draws nothing itself.
   */

  let paused = $derived(
    settings.open || settingsAsk.asking !== null || conductor.asking !== null,
  );

  $effect(() => {
    const shown = userStyles.on && !paused && userStyles.css !== "";
    userStyles.css;
    // The terminals read their colours back from the page, so a sheet
    // that changed them is a repaint for them too.
    if (paintStyles(shown)) theme.painted += 1;
  });
</script>

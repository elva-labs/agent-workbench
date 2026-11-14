/**
 * The reason the core gave for refusing the last change the window sent,
 * until another change is kept or the user dismisses it. One place every
 * setting shares, shown over the window wherever the change was made.
 */

/** What the window shows after a refusal: what the file holds, the last
    settings that could be read from it, or what it showed before, which
    is not said. */
export type Shown = "stored" | "last" | null;

const CHANGE = "The change was not saved";

export const refusal = $state({
  reason: null as string | null,
  shows: null as Shown,
  lead: CHANGE,
});

/** Shows a refused change and its reason, or clears it with null. `lead`
    says what was not done, when it was not a change. */
export function showRefusal(reason: string | null, shows: Shown = null, lead: string = CHANGE) {
  refusal.reason = reason === null ? null : reason.replace(/\.$/, "");
  refusal.shows = shows;
  refusal.lead = lead;
}

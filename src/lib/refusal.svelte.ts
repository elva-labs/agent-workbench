/**
 * The reason the core gave for refusing the last change the window sent,
 * until another change is kept or the user dismisses it. One place every
 * setting shares, shown over the window wherever the change was made.
 */

export const refusal = $state({ reason: null as string | null });

export function showRefusal(reason: string | null) {
  refusal.reason = reason;
}

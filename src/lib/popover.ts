/**
 * What puts an open popover away, wherever the keyboard and the pointer
 * are: Escape, a press outside the popover and the control that opened
 * it, the window losing focus, and the window changing size. Called while the popover is open, it
 * answers with what stops listening; a component calls it from an effect
 * that runs while its popover is open.
 *
 * Escape is taken at the window, before anything under the keyboard hears
 * it, a composer or an agent's terminal among them, so the key that puts a
 * popover away never also stops a running turn. A click on a control does
 * not move the keyboard on every platform, so the popover cannot count on
 * having it. The keyboard goes back to the control when it was in the
 * popover, and stays where it was otherwise. A key that is part of a
 * composition is left alone.
 */
export function putAway(options: {
  /** The control and its popover: a press in any of them leaves it open. */
  inside: () => (Element | null | undefined)[];
  close: () => void;
  /** Where the keyboard goes when it was in the popover. */
  control: () => HTMLElement | null | undefined;
}): () => void {
  const within = (node: Node | null) =>
    node !== null && options.inside().some((part) => part?.contains(node) ?? false);

  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const had = within(document.activeElement);
    options.close();
    if (had) options.control()?.focus();
  };
  const away = (event: PointerEvent) => {
    if (!within(event.target as Node | null)) options.close();
  };
  const resized = () => options.close();

  window.addEventListener("keydown", key, true);
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("resize", resized);
  window.addEventListener("blur", resized);
  return () => {
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("resize", resized);
    window.removeEventListener("blur", resized);
  };
}

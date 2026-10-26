/**
 * A word in the status bar that goes by itself: what a chord did when
 * nothing else on screen says so, such as the terminal's new size, or that
 * nothing is waiting. One at a time; a new word replaces the last.
 */

export const FLASH_MS = 1500;

export const flash = $state({ text: null as string | null });

let timer: ReturnType<typeof setTimeout> | null = null;
let again: ReturnType<typeof setTimeout> | null = null;

/** Shows a word. The same word again is cleared and set a task later, so
    the live region's content changes and is announced once more. */
export function say(text: string) {
  if (again !== null) clearTimeout(again);
  again = null;
  if (flash.text === text) {
    flash.text = null;
    again = setTimeout(() => {
      flash.text = text;
      again = null;
    }, 0);
  } else flash.text = text;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    flash.text = null;
    timer = null;
  }, FLASH_MS);
}

/** Test seam. */
export function resetFlash() {
  if (again !== null) clearTimeout(again);
  again = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  flash.text = null;
}

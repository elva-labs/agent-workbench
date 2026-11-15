/**
 * What a header's parts do when it is short of room. A part that gives way
 * is cut short, and once only a letter or two of it would show it is not
 * drawn at all; the parts that stay keep their width while it does.
 */

/** Marks an element `cut` while it is clipped to less than about three
    letters of its own type: such a part says nothing, so its style hides
    it. Its box keeps its place, so hiding it moves nothing. */
export function letters(node: HTMLElement, _text?: unknown) {
  const check = () => {
    const least = parseFloat(getComputedStyle(node).fontSize) * 3;
    node.classList.toggle("cut", node.scrollWidth > node.clientWidth && node.clientWidth < least);
  };
  const observer = new ResizeObserver(check);
  observer.observe(node);
  check();
  return {
    update: check,
    destroy: () => observer.disconnect(),
  };
}

/** The width an element's own text takes, whatever the box it is in. */
function textWidth(node: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect().width;
}

/** Sets `--keep` on a header's head: the width of what in it is marked
    `data-keep`, which stays whole until the header's status has given way.
    Measured again when the head or what it keeps changes size, and when
    what it holds changes. */
export function keeps(node: HTMLElement) {
  const sizes = new ResizeObserver(() => measure());
  const content = new MutationObserver(() => {
    watch();
    measure();
  });

  function kept(): HTMLElement[] {
    return [...node.querySelectorAll<HTMLElement>("[data-keep]")];
  }

  function watch() {
    sizes.disconnect();
    sizes.observe(node);
    for (const part of kept()) sizes.observe(part);
  }

  function measure() {
    // A pixel over, so a width laid out to a fraction short of the text
    // never cuts it.
    const width = kept().reduce((sum, part) => sum + textWidth(part), 0);
    node.style.setProperty("--keep", width > 0 ? `${Math.ceil(width) + 1}px` : "0px");
  }

  watch();
  measure();
  content.observe(node, { subtree: true, childList: true, characterData: true });
  void document.fonts?.ready.then(measure);
  return {
    destroy() {
      sizes.disconnect();
      content.disconnect();
    },
  };
}

/**
 * Lets a row's parts go, a step at a time and in the order given, until
 * what is left fits: each step's name joins the row's `data-fit`, which its
 * style reads to hide or fold a part. The row is measured with every part
 * at its whole width, so the steps go before anything is cut short, and
 * again whenever its width, its text or a part's class changes. All of it
 * happens before the row is painted, so no step is ever seen coming and
 * going.
 */
export function fits(node: HTMLElement, steps: string[]) {
  function measure() {
    node.dataset.measuring = "";
    const taken: string[] = [];
    node.dataset.fit = "";
    while (node.scrollWidth > node.clientWidth && taken.length < steps.length) {
      taken.push(steps[taken.length]);
      node.dataset.fit = taken.join(" ");
    }
    delete node.dataset.measuring;
  }

  const sizes = new ResizeObserver(measure);
  const content = new MutationObserver(measure);
  sizes.observe(node);
  content.observe(node, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  measure();
  void document.fonts?.ready.then(measure);
  return {
    update(next: string[]) {
      steps = next;
      measure();
    },
    destroy() {
      sizes.disconnect();
      content.disconnect();
    },
  };
}

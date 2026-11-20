import { describe, expect, it } from "vitest";
import { fits } from "$lib/giveWay";

describe("what gives way in a row", () => {
  /** A row whose content is as wide as its parts that have not given way. */
  function row(width: () => number, parts: Record<string, number>, base: number) {
    const node = document.createElement("div");
    Object.defineProperty(node, "clientWidth", { get: width });
    Object.defineProperty(node, "scrollWidth", {
      get: () => {
        const gone = (node.dataset.fit ?? "").split(" ").filter(Boolean);
        return base + Object.entries(parts).reduce((sum, [step, size]) => sum + (gone.includes(step) ? 0 : size), 0);
      },
    });
    return node;
  }

  const parts = { chrome: 160, prefix: 60, fold: 200, reset: 120 };
  const steps = Object.keys(parts);

  it("lets parts go in order until the rest fits, and no more", () => {
    // 940 with everything, 400 once every part has gone.
    const cases: [number, string][] = [
      [940, ""],
      [900, "chrome"],
      [750, "chrome prefix"],
      [600, "chrome prefix fold"],
      [450, "chrome prefix fold reset"],
      // Narrower than what is left: every step is taken, and that is all.
      [300, "chrome prefix fold reset"],
    ];
    for (const [width, fit] of cases) {
      const node = row(() => width, parts, 400);
      const action = fits(node, steps);
      expect(node.dataset.fit, `at ${width}`).toBe(fit);
      expect("measuring" in node.dataset).toBe(false);
      action.destroy();
    }
  });

  it("takes a step for a part over by a fraction of a pixel, which the whole-number width hides", () => {
    const node = row(() => 940, parts, 400);
    const last = document.createElement("span");
    node.append(last);
    node.getBoundingClientRect = () => ({ right: 952 }) as DOMRect;
    // Past the row's inner edge, 940 from its left, while every part is
    // drawn; inside it once the first step is taken.
    last.getBoundingClientRect = () => ({ right: node.dataset.fit === "" ? 940.4 : 780 }) as DOMRect;
    node.style.paddingRight = "12px";
    // Computed style is read from the document, as in a browser.
    document.body.append(node);
    const action = fits(node, steps);
    expect(node.dataset.fit).toBe("chrome");
    action.destroy();
    node.remove();
  });

  it("gives parts back when the row has room again", () => {
    let width = 450;
    const node = row(() => width, parts, 400);
    const action = fits(node, steps);
    expect(node.dataset.fit).toBe("chrome prefix fold reset");
    width = 1200;
    action.update(steps);
    expect(node.dataset.fit).toBe("");
    action.destroy();
  });
});

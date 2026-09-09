/**
 * Mermaid diagrams the agent presents, rendered to SVG: a `.mmd` file on
 * its own, or a fenced block in a Markdown document. The library is large
 * and loaded on the first diagram only.
 */

import { resolvedTheme } from "$lib/theme.svelte";

type Mermaid = typeof import("mermaid").default;

let library: Promise<Mermaid> | null = null;
let count = 0;

function mermaid(): Promise<Mermaid> {
  if (library === null) {
    library = import("mermaid").then((module) => {
      const api = module.default;
      api.initialize({
        startOnLoad: false,
        // Labels are text: the diagram is the agent's, the window is the app's.
        securityLevel: "strict",
        theme: resolvedTheme() === "dark" ? "dark" : "neutral",
        fontFamily: "inherit",
      });
      return api;
    });
  }
  return library;
}

/** The diagram as SVG, or the reason it could not be drawn. */
export async function renderDiagram(
  code: string,
): Promise<{ svg: string } | { error: string }> {
  try {
    const api = await mermaid();
    const { svg } = await api.render(`workbench-diagram-${++count}`, code);
    return { svg };
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error) };
  }
}

/** A Svelte action: every fenced mermaid block in a rendered document is
    replaced by its diagram, as it is drawn. */
export function fences(node: HTMLElement, _html?: string) {
  const draw = () => {
    for (const code of node.querySelectorAll("pre > code.language-mermaid")) {
      const pre = code.parentElement;
      if (pre === null || pre.dataset.drawn === "1") continue;
      pre.dataset.drawn = "1";
      const source = code.textContent ?? "";
      void renderDiagram(source).then((result) => {
        if (!pre.isConnected) return;
        if ("error" in result) {
          pre.title = result.error;
          return;
        }
        const figure = document.createElement("figure");
        figure.className = "diagram";
        figure.innerHTML = result.svg;
        pre.replaceWith(figure);
      });
    }
  };
  draw();
  return {
    update: (_html?: string) => draw(),
  };
}

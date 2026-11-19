/**
 * A long conversation's history as the core reads it from a transcript,
 * made up, with the shape of a real one a session kept for days: 334 turns,
 * a third of them begun by the user and the rest by the agent, about 2,400
 * tool calls, most of them commands and MCP tools and one turn in ten of
 * up to forty-five, replies of a few hundred to a few thousand characters,
 * outputs from a line to the 16 KB a history keeps, fifteen images, four
 * compactions and four subagents, over three days.
 *
 * It runs in the page, so it is passed whole to `page.evaluate` and uses
 * nothing from outside itself. The same start gives the same history.
 */
export function longHistory({ start, turns = 334 }: { start: number; turns?: number }) {
  // A small seeded generator, so every run draws the same conversation.
  let seed = 7;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  const WORDS =
    "the change keeps a session open while it waits for the review and then reads what came back before it goes on with the next piece of work in the project".split(
      " ",
    );
  const words = (length: number) => {
    let out = "";
    while (out.length < length) out += `${pick(WORDS)} `;
    return out.slice(0, length).trim();
  };
  /** A size drawn from a spread with the median and the long tail given. */
  const size = (median: number, high: number, most: number) => {
    const roll = random();
    if (roll < 0.5) return Math.round(median * (0.3 + random() * 0.7));
    if (roll < 0.9) return Math.round(median + random() * (high - median));
    return Math.round(high + random() * (most - high));
  };
  const reply = (length: number) => {
    const parts = [`${words(Math.min(length, 220))}.`];
    let left = length - parts[0].length;
    while (left > 0) {
      const kind = random();
      const part =
        kind < 0.25
          ? ["", "- " + words(60), "- " + words(80), "- " + words(50)].join("\n")
          : kind < 0.35
            ? "```ts\nconst value = " + Math.floor(random() * 100) + ";\nexport function run() {\n  return value * 2;\n}\n```"
            : kind < 0.42
              ? "```\nHi,\n\n- " + words(70) + "\n  - " + words(40) + "\n\nThanks\n```"
              : `${words(Math.min(left, 300))}.`;
      parts.push(part);
      left -= part.length;
    }
    return parts.join("\n\n");
  };
  /** An image of the size a screenshot is once kept, drawn on a canvas. */
  const image = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 300;
    const context = canvas.getContext("2d")!;
    for (let y = 0; y < 300; y += 6)
      for (let x = 0; x < 480; x += 6) {
        context.fillStyle = `rgb(${Math.floor(random() * 255)},${Math.floor(random() * 255)},${Math.floor(random() * 255)})`;
        context.fillRect(x, y, 6, 6);
      }
    return { mediaType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] };
  };
  /** A kind of call, about as often as the real one made each. */
  const kind = (): [string, string] => {
    const roll = random();
    if (roll < 0.47) return ["command", "Bash"];
    if (roll < 0.93) return ["mcp", pick(["mcp__workbench__wait", "mcp__workbench__notify", "mcp__workbench__start"])];
    if (roll < 0.96) return ["edit", "Edit"];
    return ["read", "Read"];
  };
  const items: { at: number; model?: string; event: Record<string, unknown> }[] = [];
  let at = start;
  let calls = 0;
  let images = 0;
  const push = (event: Record<string, unknown>, model?: string) => items.push(model === undefined ? { at, event } : { at, model, event });
  const call = (parent: string | null, kind: string, name: string) => {
    const id = `call-${++calls}`;
    push({ type: "toolStarted", call: id, parent, name, kind });
    const input =
      kind === "edit"
        ? { file_path: `/projects/demo/src/part-${calls % 40}.ts`, old_string: words(size(120, 600, 2000)), new_string: words(size(120, 600, 2000)) }
        : kind === "read"
          ? { file_path: `/projects/demo/src/part-${calls % 40}.ts` }
          : kind === "mcp"
            ? { session: `session-${calls % 9}`, prompt: words(size(300, 2300, 6000)) }
            : { command: `rg -n "${pick(WORDS)}" src && ${words(size(80, 400, 1200))}` };
    push({ type: "toolInput", call: id, parent, delta: null, input, truncated: false });
    at += 2_000;
    const output = Array.from({ length: Math.max(1, Math.round(size(233, 3200, 16384) / 60)) }, () => words(59)).join("\n");
    push({ type: "toolFinished", call: id, parent, output, error: random() < 0.04, truncated: output.length >= 16384, changes: [] });
    return id;
  };
  const SUBAGENTS = new Map([
    [40, 13],
    [120, 14],
    [200, 13],
    [290, 37],
  ]);
  const COMPACTED = new Set([80, 160, 240, 310]);
  const IMAGED = new Set(Array.from({ length: 15 }, (_, index) => 6 + index * 22));
  let said = 0;
  for (let turn = 1; turn <= turns; turn++) {
    if (COMPACTED.has(turn)) push({ type: "compacted", reason: "full", tokensBefore: 180_000, tokensAfter: 30_000 });
    // A third of the turns answer the user; the rest the agent begins on
    // what its sessions report.
    const asked = turn % 3 === 1 || IMAGED.has(turn);
    const messages: string[] = [];
    if (asked) {
      const message = `message-${++said}`;
      messages.push(message);
      const withImage = IMAGED.has(turn) && images < 15;
      if (withImage) images += 1;
      push({ type: "message", message, state: "sent", error: null, text: `Question ${turn}: ${words(size(180, 900, 2500))}`, images: withImage ? [image()] : [] });
    }
    push({ type: "turnStarted", messages }, "claude-opus-4-1");
    const first = random() < 0.6;
    if (first) push({ type: "text", block: `block-${turn}-a`, parent: null, text: reply(size(400, 1200, 2500)), done: true });
    // Most turns make a few calls; one in ten makes many.
    const many = random() < 0.1 ? 10 + Math.floor(random() * 36) : 2 + Math.floor(random() * 6);
    for (let step = 0; step < many; step++) call(null, ...kind());
    const subagent = SUBAGENTS.get(turn);
    if (subagent !== undefined) {
      const id = `call-${++calls}`;
      push({ type: "toolStarted", call: id, parent: null, name: "Task", kind: "agent" });
      push({ type: "toolInput", call: id, parent: null, delta: null, input: { description: words(40), prompt: words(800), subagent_type: "general-purpose" }, truncated: false });
      for (let step = 0; step < subagent; step++) call(id, "command", "Bash");
      push({ type: "text", block: `block-${turn}-sub`, parent: id, text: reply(600), done: true });
      push({ type: "toolFinished", call: id, parent: null, output: words(900), error: false, truncated: false, changes: [] });
    }
    push({ type: "text", block: `block-${turn}-b`, parent: null, text: `Reply ${turn}. ${reply(size(588, 1845, 3084))}`, done: true });
    at += 20_000;
    push({ type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 60_000, usage: null });
    // Three days in all, as the real one ran.
    at += 700_000;
  }
  return items;
}

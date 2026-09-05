import { describe, expect, it, vi } from "vitest";
import { WriteQueue, buildTheme, colorReply, softwareGl, withAlpha } from "$lib/terminal";
import { toBytes } from "$lib/core";

describe("toBytes", () => {
  // Tauri's raw IPC does not pin down the JavaScript shape, so all of these
  // are shapes the channel can plausibly hand over.
  it("passes a Uint8Array through unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toBytes(bytes)).toBe(bytes);
  });

  it("wraps an ArrayBuffer", () => {
    const buffer = new Uint8Array([4, 5, 6]).buffer;
    expect(Array.from(toBytes(buffer))).toEqual([4, 5, 6]);
  });

  it("respects the offset of a view onto a larger buffer", () => {
    const backing = new Uint8Array([9, 9, 7, 8, 9, 9]);
    const view = new Uint8Array(backing.buffer, 2, 2);
    expect(Array.from(toBytes(view))).toEqual([7, 8]);
  });

  it("converts a plain array of numbers", () => {
    expect(Array.from(toBytes([65, 66]))).toEqual([65, 66]);
  });

  it("returns nothing for anything else, rather than throwing mid-stream", () => {
    expect(toBytes(null)).toHaveLength(0);
    expect(toBytes({ nope: true })).toHaveLength(0);
    expect(toBytes("text")).toHaveLength(0);
  });
});

describe("withAlpha", () => {
  it("turns a hex colour into rgba", () => {
    expect(withAlpha("#16706A", 0.22)).toBe("rgba(22, 112, 106, 0.22)");
  });

  it("accepts a colour without the hash", () => {
    expect(withAlpha("58C0B4", 0.5)).toBe("rgba(88, 192, 180, 0.5)");
  });

  it("expands a three-digit colour", () => {
    expect(withAlpha("#abc", 1)).toBe("rgba(170, 187, 204, 1)");
  });

  it("leaves anything it cannot parse alone", () => {
    expect(withAlpha("var(--accent)", 0.2)).toBe("var(--accent)");
    expect(withAlpha("", 0.2)).toBe("");
  });
});

describe("buildTheme", () => {
  const tokens: Record<string, string> = {
    "--surface": "#FFFFFF",
    "--ink": "#14181A",
    "--accent": "#16706A",
    "--ansi-black": "#14181A",
    "--ansi-red": "#9B3A47",
    "--ansi-green": "#2E6B3F",
    "--ansi-yellow": "#8A6A1F",
    "--ansi-blue": "#2F5AA8",
    "--ansi-magenta": "#7A4A8C",
    "--ansi-cyan": "#16706A",
    "--ansi-white": "#4E5A59",
    "--ansi-bright-black": "#3A4244",
    "--ansi-bright-red": "#BE5766",
    "--ansi-bright-green": "#43895A",
    "--ansi-bright-yellow": "#A9853A",
    "--ansi-bright-blue": "#4C76C4",
    "--ansi-bright-magenta": "#9765A8",
    "--ansi-bright-cyan": "#2A8C85",
    "--ansi-bright-white": "#7D8988",
  };
  const read = (token: string) => tokens[token] ?? "";
  const theme = buildTheme(read);

  // The background being a shade off is the clearest tell that a terminal was
  // pasted into a window.
  it("takes the background exactly from the surface token", () => {
    expect(theme.background).toBe(tokens["--surface"]);
  });

  it("uses the accent for the cursor", () => {
    expect(theme.cursor).toBe(tokens["--accent"]);
  });

  // The move that makes the agent's own output carry the app's colour.
  it("makes ANSI cyan the accent", () => {
    expect(theme.cyan).toBe(tokens["--accent"]);
  });

  it("gives the selection a translucent accent", () => {
    expect(theme.selectionBackground).toBe("rgba(22, 112, 106, 0.22)");
  });

  it("fills all sixteen slots", () => {
    const slots = [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const;

    for (const slot of slots) {
      expect(theme[slot], slot).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("gives every slot a distinct colour except the deliberate cyan match", () => {
    const values = Object.entries(theme)
      .filter(([key]) => key !== "cursor" && key !== "cyan" && key !== "cursorAccent")
      .map(([, value]) => value);
    expect(new Set(values).size).toBeGreaterThan(15);
  });
});

describe("WriteQueue", () => {
  function harness() {
    const written: string[] = [];
    const held: { frame: (() => void) | null } = { frame: null };
    const queue = new WriteQueue(
      (data) => written.push(new TextDecoder().decode(data)),
      (cb) => {
        held.frame = cb;
        return 1;
      },
      () => {
        held.frame = null;
      },
    );
    return { queue, written, frame: () => held.frame?.() };
  }

  const bytes = (text: string) => new TextEncoder().encode(text);

  it("writes nothing until the frame arrives", () => {
    const { queue, written, frame } = harness();
    queue.push(bytes("hello"));
    expect(written).toEqual([]);
    frame();
    expect(written).toEqual(["hello"]);
  });

  // A TUI redraw is many small writes; one parse per frame beats one per chunk.
  it("joins everything that arrived in the same frame into one write", () => {
    const { queue, written, frame } = harness();
    queue.push(bytes("one "));
    queue.push(bytes("two "));
    queue.push(bytes("three"));
    frame();
    expect(written).toEqual(["one two three"]);
  });

  it("schedules only one frame per batch", () => {
    const schedule = vi.fn(() => 1);
    const queue = new WriteQueue(() => {}, schedule, () => {});
    queue.push(bytes("a"));
    queue.push(bytes("b"));
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("schedules again after a flush", () => {
    const { queue, written, frame } = harness();
    queue.push(bytes("first"));
    frame();
    queue.push(bytes("second"));
    frame();
    expect(written).toEqual(["first", "second"]);
  });

  it("ignores empty chunks", () => {
    const schedule = vi.fn(() => 1);
    const queue = new WriteQueue(() => {}, schedule, () => {});
    queue.push(new Uint8Array());
    expect(schedule).not.toHaveBeenCalled();
  });

  it("writes nothing on an empty flush", () => {
    const { queue, written, frame } = harness();
    frame();
    expect(written).toEqual([]);
    queue.flush();
    expect(written).toEqual([]);
  });

  // A multi-byte character split across two reads must survive the join.
  it("keeps a UTF-8 sequence split across chunks intact", () => {
    const { queue, written, frame } = harness();
    const full = new TextEncoder().encode("⏺");
    queue.push(full.slice(0, 1));
    queue.push(full.slice(1));
    frame();
    expect(written).toEqual(["⏺"]);
  });

  // The default scheduler is the real requestAnimationFrame, and calling it
  // with the wrong receiver throws "Illegal invocation" only at runtime.
  it("works with its own default scheduler", async () => {
    const written: string[] = [];
    const queue = new WriteQueue((data) => written.push(new TextDecoder().decode(data)));

    expect(() => queue.push(bytes("real frame"))).not.toThrow();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(written).toEqual(["real frame"]);

    expect(() => queue.dispose()).not.toThrow();
  });

  it("drops pending output and cancels its frame when disposed", () => {
    const cancel = vi.fn();
    const written: string[] = [];
    const held: { frame: (() => void) | null } = { frame: null };
    const queue = new WriteQueue(
      (data) => written.push(new TextDecoder().decode(data)),
      (cb) => {
        held.frame = cb;
        return 7;
      },
      cancel,
    );

    queue.push(bytes("abandoned"));
    queue.dispose();
    expect(cancel).toHaveBeenCalledWith(7);

    held.frame?.();
    expect(written).toEqual([]);
  });
});

describe("colorReply", () => {
  const theme = { foreground: "#1a2b3c", background: "#FAFAF7" };

  it("answers a colour query with the theme's colour, 16 bits a channel", () => {
    expect(colorReply(10, "?", theme)).toBe("\x1b]10;rgb:1a1a/2b2b/3c3c\x1b\\");
    expect(colorReply(11, "?", theme)).toBe("\x1b]11;rgb:FAFA/FAFA/F7F7\x1b\\");
  });

  it("leaves a colour being set to the terminal", () => {
    expect(colorReply(11, "rgb:0000/0000/0000", theme)).toBeNull();
    expect(colorReply(10, "#123456", theme)).toBeNull();
  });

  it("has an answer even for a theme without the colour", () => {
    expect(colorReply(11, "?", {})).toBe("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  });
});

describe("softwareGl", () => {
  it("knows a software rasteriser by name", () => {
    expect(softwareGl("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(softwareGl("Google SwiftShader")).toBe(true);
    expect(softwareGl("ANGLE (Apple, Apple M2, OpenGL 4.1)")).toBe(false);
    expect(softwareGl("WebKit WebGL")).toBe(false);
    expect(softwareGl(null)).toBe(false);
  });
});

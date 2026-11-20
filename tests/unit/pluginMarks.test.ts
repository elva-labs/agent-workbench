import { beforeEach, describe, expect, it } from "vitest";
import type { PluginMarkEvent } from "$lib/core";
import {
  markChanged,
  markLabel,
  marksOf,
  pluginMarks,
  resetPluginMarks,
} from "$lib/pluginMarks.svelte";

const mark = (extra: Partial<PluginMarkEvent> = {}): PluginMarkEvent => ({
  source: "src-1",
  plugin: "github",
  project: "/one",
  session: "tok-a",
  icon: "pull-request",
  count: 2,
  state: "ok",
  label: null,
  ...extra,
});

beforeEach(() => {
  resetPluginMarks();
});

describe("a plugin's mark", () => {
  it("is one per plugin on a session, the latest replacing the one before", () => {
    markChanged(mark());
    markChanged(mark({ count: 3, state: "failed" }));
    expect(marksOf("tok-a")).toEqual([
      { plugin: "src-1/github", icon: "pull-request", count: 3, state: "failed", label: null },
    ]);
    expect(marksOf("tok-b")).toEqual([]);
  });

  it("stands beside another plugin's, in the plugins' order", () => {
    markChanged(mark({ plugin: "linear", icon: "issue", count: null }));
    markChanged(mark());
    expect(marksOf("tok-a").map((m) => m.plugin)).toEqual(["src-1/github", "src-1/linear"]);
  });

  it("goes when the plugin sends none, leaving the other plugins' and sessions' marks", () => {
    markChanged(mark());
    markChanged(mark({ plugin: "linear", icon: "issue" }));
    markChanged(mark({ session: "tok-b" }));
    markChanged(mark({ icon: null }));
    expect(marksOf("tok-a").map((m) => m.plugin)).toEqual(["src-1/linear"]);
    expect(marksOf("tok-b")).toHaveLength(1);
    markChanged(mark({ plugin: "linear", icon: null }));
    expect(pluginMarks.bySession["tok-a"]).toBeUndefined();
  });

  it("says the plugin's own words, or its name and count", () => {
    markChanged(mark({ label: "2 pull requests, checks failing" }));
    expect(markLabel(marksOf("tok-a")[0])).toBe("2 pull requests, checks failing");
    markChanged(mark({ label: null }));
    expect(markLabel(marksOf("tok-a")[0])).toBe("github: 2");
    markChanged(mark({ label: "", count: null }));
    expect(markLabel(marksOf("tok-a")[0])).toBe("github");
  });
});

import { describe, expect, it } from "vitest";
import { migrateStorage } from "$lib/migrate";

describe("the window's storage under the earlier name", () => {
  it("moves each key to Chord's name, with paths into the moved folder", () => {
    localStorage.clear();
    localStorage.setItem("workbench.layout", '{"sessions":240}');
    localStorage.setItem(
      "workbench.open",
      JSON.stringify(["/home/ada/dev/demo", "/home/ada/.agent-workbench/orchestrator", "ssh://ada@lab/home/ada/.agent-workbench/orchestrator"]),
    );
    localStorage.setItem("workbench.orchestratorFolder", "C:\\Users\\ada\\.agent-workbench\\orchestrator");
    localStorage.setItem("workbench.tokens", '{"s1":"token-1"}');
    localStorage.setItem("workbench.theme", "dark");
    localStorage.setItem("chord.theme", "light");
    localStorage.setItem("other", "kept");

    migrateStorage(localStorage);

    expect(localStorage.getItem("chord.layout")).toBe('{"sessions":240}');
    expect(JSON.parse(localStorage.getItem("chord.open")!)).toEqual([
      "/home/ada/dev/demo",
      "/home/ada/.chord/orchestrator",
      "ssh://ada@lab/home/ada/.chord/orchestrator",
    ]);
    expect(localStorage.getItem("chord.orchestratorFolder")).toBe("C:\\Users\\ada\\.chord\\orchestrator");
    expect(localStorage.getItem("chord.tokens")).toBe('{"s1":"token-1"}');
    expect(localStorage.getItem("chord.theme")).toBe("light");
    expect(localStorage.getItem("other")).toBe("kept");
    expect(Object.keys(localStorage).filter((key) => key.startsWith("workbench."))).toEqual([]);

    const after = { ...localStorage };
    migrateStorage(localStorage);
    expect({ ...localStorage }).toEqual(after);
  });
});

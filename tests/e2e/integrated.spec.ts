import { expect, test } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The seam's integrated sessions in the browser, against the scripted
// session the fake core carries. Nothing draws a conversation yet; this
// keeps the fake the browser tests will drive honest.
test("the fake core runs a scripted integrated session behind the seam", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  const heard = await page.evaluate(async (project) => {
    const seam = window.__WORKBENCH_CORE__!;
    const events: { type: string; id: string; messages?: string[] }[] = [];
    await seam.onIntegratedEvent((event) => events.push(event));
    const { id } = await seam.integratedStart({ agent: "claude-code", project });
    const message = crypto.randomUUID();
    await seam.integratedSend(id, message, "hello");
    const integrated = (
      window as unknown as {
        __integrated: { turn(id: string, text: string): void };
      }
    ).__integrated;
    integrated.turn(id, "hi there");
    await seam.integratedStop(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { id, message, events };
  }, PROJECT);
  const types = heard.events.map((event) => event.type);
  expect(types[0]).toBe("ready");
  const started = heard.events.find((event) => event.type === "turnStarted");
  expect(started?.messages).toEqual([heard.message]);
  expect(types).toContain("turnEnded");
  expect(types.at(-1)).toBe("ended");
  expect(heard.events.every((event) => event.id === heard.id)).toBe(true);
});

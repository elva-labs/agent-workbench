import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

const SESSIONS = "section[data-pane='sessions']";
const PROJECTS = Array.from({ length: 12 }, (_, n) => `/home/ada/dev/project${String(n + 1).padStart(2, "0")}`);

async function open(page: Page, settings: Record<string, unknown>) {
  await page.setViewportSize({ width: 1440, height: 520 });
  await installFakeCore(page, { open: PROJECTS, settings });
  await page.goto("/");
  await expect(page.locator(`${SESSIONS} [data-testid='project-head']`)).toHaveCount(12);
  for (let n = 0; n < 12; n += 1) {
    const add = page.locator(`${SESSIONS} [data-testid='project-head']`).nth(n).getByTestId("project-new-session");
    for (let s = 0; s < 3; s += 1) {
      await add.click();
      await expect(page.locator(`${SESSIONS} section.proj`).nth(n).getByTestId("session-row")).toHaveCount(s + 1);
    }
  }
}

for (const look of ["modern", "terminal"] as const) {
  for (const appearance of ["dark", "light"] as const) {
    test(`the list stacks its pinned headers under its scroll bar, ${look} ${appearance}`, async ({ page }, info) => {
      await open(page, { look, appearance });
      const tree = page.locator(`${SESSIONS} .tree`);
      // Into the fourth project, so its header is pinned with rows under it.
      await tree.evaluate((list) => {
        const section = list.querySelectorAll<HTMLElement>("section.proj")[3];
        list.scrollTop += section.getBoundingClientRect().top - list.getBoundingClientRect().top + 60;
      });

      await page.screenshot({
        path: `.claude/mockups/v2/shots/scrollbar-headers/${process.env.SHOT ?? "run"}-${look}-${appearance}.png`,
        clip: { x: 0, y: 0, width: 420, height: 520 },
      });

      // The headers stack above the rows inside the list, and the list is a
      // stacking context of its own, so its scroll bar is drawn over them.
      expect(await tree.evaluate((list) => getComputedStyle(list).isolation)).toBe("isolate");
      const heads = await tree.evaluate((list) =>
        [...list.querySelectorAll<HTMLElement>("[data-testid='project-head']")].map((head) => {
          const style = getComputedStyle(head);
          return { position: style.position, zIndex: Number(style.zIndex) };
        }),
      );
      for (const head of heads) {
        expect(head.position).toBe("sticky");
        expect(head.zIndex).toBeGreaterThan(0);
      }

      // Still pinned, and rows still go under it.
      const top = (await tree.boundingBox())!.y;
      const pinned = await page.evaluate(
        ({ top }) => {
          const heads = [...document.querySelectorAll<HTMLElement>("[data-testid='project-head']")];
          return heads.some((head) => Math.abs(head.getBoundingClientRect().top - top) < 1.5);
        },
        { top },
      );
      expect(pinned).toBe(true);

      // A header takes the click where a row would scroll under it.
      const stuck = await page.evaluate(
        ({ top }) => {
          const heads = [...document.querySelectorAll<HTMLElement>("[data-testid='project-head']")];
          const one = heads.find((h) => Math.abs(h.getBoundingClientRect().top - top) < 1.5)!;
          const box = one.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + 20, box.top + box.height / 2);
          return one.contains(hit);
        },
        { top },
      );
      expect(stuck).toBe(true);

    });
  }
}

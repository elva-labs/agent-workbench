import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_FIXTURE, PROJECT, installFakeCore } from "./fake";

// Mentioning a file with @ and attaching any file, in an integrated
// session's composer, against the fake core's repository and its scripted
// session.

const FIXTURE = {
  status: DEFAULT_FIXTURE.status,
  files: [...DEFAULT_FIXTURE.files, "docs/release notes.md"].sort(),
};

function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

async function sent(page: Page): Promise<string> {
  const send = (await calls(page)).find((call) => call.method === "send") as unknown as { text: string } | undefined;
  return send?.text ?? "";
}

async function openIntegrated(page: Page) {
  await installFakeCore(page, { open: [PROJECT], fixture: FIXTURE, settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(input(page)).toBeVisible();
}

const menu = (page: Page) => page.getByTestId("file-menu");
const rows = (page: Page) => page.getByTestId("file-menu-row");
const input = (page: Page) => page.getByTestId("composer-input");

/** The rows as each reads, after the group it is under. */
async function listed(page: Page): Promise<string[]> {
  return menu(page)
    .locator("[role='group']")
    .evaluateAll((groups) =>
      groups.flatMap((group) => {
        const head = group.querySelector("p.head")?.textContent?.trim() ?? "";
        return [...group.querySelectorAll("[role='option']")].map((row) => {
          const name = row.querySelector("[data-testid='file-name']")?.textContent?.replace(",", "").trim();
          const dir = row.querySelector("[data-testid='file-dir']")?.textContent?.replace(",", "").trim();
          return [head, dir === "" ? name : `${dir}/${name}`].filter(Boolean).join(" ");
        });
      }),
    );
}

test.describe("mentioning a file with @", () => {
  test("opens what changed, then the project's top, over the thread and as wide as the composer", async ({ page }) => {
    await openIntegrated(page);
    await expect(input(page)).toHaveAttribute("placeholder", "Tell Claude what to do. Type / for commands, @ for files");
    await input(page).click();
    await page.keyboard.type("Why does @");
    await expect(menu(page)).toBeVisible();
    // The deleted file is not offered: there is nothing left to read.
    expect(await listed(page)).toEqual([
      "Changed src/cache/mod.rs",
      "Changed src/lib.rs",
      "Files Cargo.toml",
      "Files docs/",
      "Files README.md",
      "Files src/",
      "Files tests/",
    ]);
    await expect(rows(page).first()).toContainText("+18");
    await expect(rows(page).first()).toContainText("−6");
    await expect(page.getByTestId("slash-announce")).toHaveText("7 files");
    const box = (await menu(page).boundingBox())!;
    const composer = (await page.getByTestId("composer").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
    expect(box.x).toBeCloseTo(composer.x, 0);
    await expect(input(page)).toHaveAttribute("aria-activedescendant", /files-.*-0/);
  });

  test("narrows by name, then by path, and marks the letters that matched", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("@sto");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator("b")).toHaveText("sto");
    expect(await listed(page)).toEqual(["src/cache/store.rs"]);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("cache/m");
    await expect.poll(() => listed(page)).toEqual(["src/cache/mod.rs"]);
    await expect(rows(page).first().locator("[data-testid='file-dir'] b")).toHaveText("cache");
  });

  test("puts the picked file in as its path in the accent, and Backspace takes it out whole", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("Why does @sto");
    await page.keyboard.press("Enter");
    await expect(menu(page)).toBeHidden();
    await expect(input(page)).toHaveValue("Why does @src/cache/store.rs ");
    await page.keyboard.type("fill?");
    const mention = page.getByTestId("composer-mention");
    await expect(mention).toHaveText("@src/cache/store.rs");
    const [accent, drawn, own] = await mention.evaluate((element) => {
      const field = document.querySelector("[data-testid='composer-input']")!;
      const send = document.querySelector("[data-testid='send']")!;
      return [getComputedStyle(send).backgroundColor, getComputedStyle(element).color, getComputedStyle(field).color];
    });
    expect(drawn).toBe(accent);
    expect(own).toBe("rgba(0, 0, 0, 0)");
    // The drawn text lies where the field's own would.
    const word = (await mention.boundingBox())!;
    const field = (await input(page).boundingBox())!;
    expect(word.y).toBeGreaterThanOrEqual(field.y - 1);
    expect(word.y + word.height).toBeLessThanOrEqual(field.y + field.height + 1);

    for (let at = 0; at < "fill?".length + 1; at++) await page.keyboard.press("Backspace");
    await expect(input(page)).toHaveValue("Why does @src/cache/store.rs");
    await page.keyboard.press("Backspace");
    await expect(input(page)).toHaveValue("Why does ");
    await expect(mention).toHaveCount(0);
  });

  test("keeps the drawn mention on the field's own text when a long message scrolls", async ({ page }) => {
    await openIntegrated(page);
    await input(page).fill(Array.from({ length: 40 }, (_, at) => `line ${at}`).join("\n") + "\n");
    await page.keyboard.type("see @sto");
    await page.keyboard.press("Enter");
    const mention = page.getByTestId("composer-mention");
    await expect(mention).toHaveText("@src/cache/store.rs");
    const field = (await input(page).boundingBox())!;
    expect(await input(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const word = (await mention.boundingBox())!;
    expect(word.y).toBeGreaterThanOrEqual(field.y);
    expect(word.y + word.height).toBeLessThanOrEqual(field.y + field.height + 1);
  });

  test("chooses with the arrows and Tab, and keeps a path with spaces in one piece", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("@notes");
    expect(await listed(page)).toEqual(["docs/release notes.md"]);
    await page.keyboard.press("Tab");
    await expect(input(page)).toHaveValue("@docs/release notes.md ");
    await expect(page.getByTestId("composer-mention")).toHaveText("@docs/release notes.md");
    await page.keyboard.type("@");
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("@docs/release notes.md @tests/ ");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(page)).toBe("`@docs/release notes.md` `@tests/` ");
  });

  test("finds a file among tens of thousands, and Enter before the answer picks it once it comes", async ({ page }) => {
    const files = Array.from({ length: 30000 }, (_, at) => `pkg${at % 300}/src/module${at}.ts`);
    await installFakeCore(page, {
      open: [PROJECT],
      fixture: { status: [], files },
      settings: { integrated: ["claude-code"] },
    });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await input(page).click();
    await page.keyboard.type("@module29999");
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("@pkg299/src/module29999.ts ");
    await page.keyboard.type("@");
    // The top of the project, as many as the menu shows.
    await expect(rows(page)).toHaveCount(50);
    await expect(rows(page).first()).toContainText("pkg0/");
  });

  test("Escape closes the menu without stopping the agent", async ({ page }) => {
    await openIntegrated(page);
    await page.evaluate(
      `(() => { const f = window.__integrated; f.send("int-1", crypto.randomUUID(), "go"); f.startTurn("int-1"); })()`,
    );
    await expect(page.getByTestId("stop")).toBeVisible();
    await input(page).click();
    await page.keyboard.type("and @");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(page.getByTestId("stop")).toBeVisible();
    expect((await calls(page)).some((call) => call.method === "interrupt")).toBe(false);
    // Typing on opens it again.
    await page.keyboard.type("s");
    await expect(menu(page)).toBeVisible();
  });

  test("leaves an @ in an email address or in code as text", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("mail ada@example.com");
    await expect(menu(page)).toBeHidden();
    await input(page).fill("");
    await page.keyboard.type("run `npm i @types");
    await expect(menu(page)).toBeHidden();
  });

  test("says when nothing matches, and a space closes it", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("@zzz");
    await expect(page.getByTestId("file-menu-empty")).toHaveText("No file in demo matches zzz.");
    await expect(page.getByTestId("slash-announce")).toHaveText("No file in demo matches zzz.");
    await page.keyboard.type(" ");
    await expect(menu(page)).toBeHidden();
  });

  test("sends the path for the agent to read, and the message shows it as a link to the file", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("Why does @store");
    await page.keyboard.press("Enter");
    await page.keyboard.type("fill so slowly?");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(page)).toBe("Why does `@src/cache/store.rs` fill so slowly?");
    const link = page.getByTestId("user-message").getByTestId("message-mention");
    await expect(link).toHaveText("@src/cache/store.rs");
    await expect(page.getByTestId("user-message")).toContainText("Why does @src/cache/store.rs fill so slowly?");
    await link.click();
    await expect(page.getByTestId("viewer").locator(".bar .path")).toHaveText("src/cache/store.rs");
  });
});

test.describe("attaching any file", () => {
  test("shows a file that is not an image as a card with its name and size, and sends its path", async ({ page }) => {
    await openIntegrated(page);
    await page.evaluate(
      (project) => {
        const w = window as unknown as { __picked: string[]; __sizes: Record<string, number> };
        w.__picked = [`${project}/src/main.rs`, "/home/ada/Downloads/schema.sql", "/home/ada/shot.png"];
        w.__sizes = { [`${project}/src/main.rs`]: 2.1 * 1024 * 1024, "/home/ada/Downloads/schema.sql": 4096 };
      },
      PROJECT,
    );
    await expect(page.getByTestId("attach")).toHaveAttribute("title", "Attach files");
    await page.getByTestId("attach").click();
    const cards = page.getByTestId("attached-file");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("main.rs");
    await expect(cards.nth(0).getByTestId("attached-file-about")).toHaveText("2.1 MB");
    await expect(cards.nth(1).getByTestId("attached-file-about")).toHaveText("4 KB, from Downloads");
    await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
    await expect(input(page)).toBeFocused();

    await cards.nth(0).getByTestId("remove-attached-file").click();
    await expect(cards).toHaveCount(1);
    await page.keyboard.type("What is in this?");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(page)).toBe("What is in this?\n\n`@/home/ada/Downloads/schema.sql`");
    await expect(cards).toHaveCount(0);
    // A file outside the project is not one the viewer opens.
    const mention = page.getByTestId("user-message").getByTestId("message-mention");
    await expect(mention).toHaveText("@/home/ada/Downloads/schema.sql");
    expect(await mention.evaluate((element) => element.tagName)).toBe("SPAN");
  });

  test("takes a file dropped inside the project by its path from the project", async ({ page }) => {
    await openIntegrated(page);
    const box = (await page.getByTestId("composer").boundingBox())!;
    await page.evaluate(
      ({ x, y, path }) =>
        (window as unknown as { __fileDrag: (drag: unknown) => void }).__fileDrag({ type: "drop", paths: [path], x, y }),
      { x: box.x + 40, y: box.y + 20, path: `${PROJECT}/README.md` },
    );
    await expect(page.getByTestId("attached-file")).toHaveText(/README\.md\s*,?\s*2 KB/);
    await input(page).click();
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(page)).toBe("`@README.md`");
  });
});

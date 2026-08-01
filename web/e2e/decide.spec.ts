import { expect, test, type Browser, type Page } from "@playwright/test";

// What the assignment actually asks to work: one person speaks to their AI,
// the other person decides, and both see the result. Two browser contexts,
// one relay, no mocks — the same socket and session cookie as production.

const PHONE = { width: 420, height: 900 };
const DESKTOP = { width: 1440, height: 900 };

async function signIn(browser: Browser, userID: string, viewport: typeof PHONE) {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(`/auth/dev?user=${userID}`);
  await expect(page.getByRole("button", { name: "Tell your AI" })).toBeVisible();
  return page;
}

/** Say it, review the draft, route it. */
async function routeCard(page: Page, instruction: string, recipient: string) {
  await page.getByRole("button", { name: "Tell your AI" }).click();
  await page.getByRole("textbox", { name: "Tell your AI what you need" }).fill(instruction);
  await page.getByRole("button", { name: "Draft" }).click();

  await expect(page.getByText("Review card")).toBeVisible();
  await expect(page.getByText(`→ ${recipient}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send decision card" }).click();
  await expect(page.getByText(`Routed to ${recipient}`)).toBeVisible();
}

test("an unauthenticated visitor gets the app shell and a way in", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
});

test("a decision travels from Alice's AI to Bob's feed and back", async ({ browser }) => {
  const alice = await signIn(browser, "user-alice", PHONE);
  const bob = await signIn(browser, "user-bob", PHONE);

  await routeCard(alice, "Bob needs to approve the new vendor contract", "Bob");

  // It arrives in Bob's feed over the socket, with no reload.
  const card = bob.getByRole("article", { name: /from Alice/ }).first();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: /^Approve:/ }).click();
  await expect(card.getByRole("button", { name: /^Approve:/ })).toBeHidden();

  // And Alice is told — the loop closes without either of them refreshing.
  await expect(alice.getByRole("article", { name: /from Bob/ }).first()).toBeVisible();
});

test("the desktop workbench decides a card from the keyboard alone", async ({ browser }) => {
  const alice = await signIn(browser, "user-alice", DESKTOP);
  const bob = await signIn(browser, "user-bob", DESKTOP);

  // Wide viewport → the workbench, not the phone shell.
  await expect(bob.getByRole("button", { name: "Decisions" })).toBeVisible();

  await routeCard(alice, "Bob needs to approve the new API rate limits", "Bob");

  // A card arriving never steals the selection, so walk the queue to it —
  // `K` moves towards the newest. Only the selected card is expanded.
  const card = bob.getByRole("article").first();
  for (let i = 0; i < 8; i += 1) {
    if (/rate limits/i.test((await card.textContent()) ?? "")) break;
    await bob.keyboard.press("k");
  }
  await expect(card).toContainText(/rate limits/i);

  // No click anywhere in this test: Enter approves the selected card.
  await bob.keyboard.press("Enter");
  await expect(card.getByRole("button", { name: /^Approve:/ })).toBeHidden();
});

test("the command palette navigates without the mouse", async ({ browser }) => {
  const page = await signIn(browser, "user-alice", DESKTOP);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();

  await page.getByRole("textbox", { name: "Run a command" }).fill("Go to Channels");
  await page.keyboard.press("Enter");

  await expect(palette).toBeHidden();
  await expect(page.getByRole("button", { name: "Channels" })).toHaveAttribute(
    "aria-current",
    "true"
  );
});

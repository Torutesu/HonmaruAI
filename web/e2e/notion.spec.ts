import { expect, test, type Browser } from "@playwright/test";

// The promise of one-tap provenance, end to end: a decision that mentions a
// document arrives with that document's real title attached, and the document
// opens next to the decision instead of in another tab.
//
// The relay talks to a fixture workspace over its real HTTP client, so
// everything here except Notion's own servers is the production path.

const PHONE = { width: 420, height: 900 };
const SPEC_URL =
  "https://www.notion.so/team/Onboarding-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

async function signIn(browser: Browser, userID: string) {
  const page = await (await browser.newContext({ viewport: PHONE })).newPage();
  await page.goto(`/auth/dev?user=${userID}`);
  await expect(page.getByRole("button", { name: "Tell your AI" })).toBeVisible();
  return page;
}

test("a linked Notion page arrives as its real title and reads in place", async ({
  browser,
}) => {
  const alice = await signIn(browser, "user-alice");
  const bob = await signIn(browser, "user-bob");

  await alice.getByRole("button", { name: "Tell your AI" }).click();
  await alice
    .getByRole("textbox", { name: "Tell your AI what you need" })
    .fill(`Bob needs to approve the onboarding rewrite — spec: ${SPEC_URL}`);
  await alice.getByRole("button", { name: "Draft" }).click();
  await alice.getByRole("button", { name: "Send decision card" }).click();

  // The chip says what the document *is*, not merely that it is "Notion".
  const card = bob.getByRole("article", { name: /from Alice/ }).first();
  const chip = card.getByRole("button", { name: "Read Onboarding rewrite spec" });
  await expect(chip).toBeVisible();

  // One tap, and the source is here — no tab switch, no lost place.
  await chip.click();
  const preview = bob.getByRole("dialog", { name: /Onboarding/ });
  await expect(preview).toContainText("Three screens, no new backend work.");
  await expect(preview.getByRole("link", { name: /Open in Notion/ })).toHaveAttribute(
    "href",
    SPEC_URL
  );

  // Escape closes it, back to the decision.
  await bob.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(card.getByRole("button", { name: /^Approve:/ })).toBeVisible();
});

test("a decision that links nothing still gets its document found", async ({ browser }) => {
  const alice = await signIn(browser, "user-alice");
  const bob = await signIn(browser, "user-bob");

  await alice.getByRole("button", { name: "Tell your AI" }).click();
  await alice
    .getByRole("textbox", { name: "Tell your AI what you need" })
    .fill("Bob needs to approve the onboarding rewrite scope");
  await alice.getByRole("button", { name: "Draft" }).click();
  await alice.getByRole("button", { name: "Send decision card" }).click();

  // Nobody pasted a link; the AI searched the workspace with the decision's
  // own words and attached what it found.
  const card = bob.getByRole("article", { name: /from Alice/ }).first();
  await expect(card.getByRole("button", { name: "Read Onboarding rewrite spec" })).toBeVisible();
});

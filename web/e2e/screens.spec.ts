import { expect, test, type Browser, type Page } from "@playwright/test";

// Not an assertion suite — a screenshot rig for design work. Run it to see
// what the app actually looks like right now:
//   npx playwright test e2e/screens.spec.ts
// Shots land in web/screens/.

const PHONE = { width: 420, height: 900 };
const DESKTOP = { width: 1440, height: 900 };
const OUT = "screens";

async function signIn(
  browser: Browser,
  userID: string,
  viewport: typeof PHONE,
  colorScheme: "dark" | "light" = "dark"
) {
  const page = await (await browser.newContext({ viewport, colorScheme })).newPage();
  await page.goto(`/auth/dev?user=${userID}`);
  await expect(page.getByRole("button", { name: "Tell your AI" })).toBeVisible();
  return page;
}

async function route(page: Page, instruction: string, recipient: string) {
  await page.getByRole("button", { name: "Tell your AI" }).click();
  await page.getByRole("textbox", { name: "Tell your AI what you need" }).fill(instruction);
  await page.getByRole("button", { name: "Draft" }).click();
  await expect(page.getByText(`→ ${recipient}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send decision card" }).click();
  await expect(page.getByText(`Routed to ${recipient}`)).toBeVisible();
}

test("capture every screen", async ({ browser }) => {
  const alice = await signIn(browser, "user-alice", PHONE);

  await route(
    alice,
    "Bob needs to approve the new vendor contract — spec: https://www.notion.so/team/Onboarding-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "Bob"
  );
  await route(alice, "Ask Bob to fix the login regression before Friday", "Bob");
  await route(alice, "Bob needs to approve the staging rollout to 10%", "Bob");

  const bob = await signIn(browser, "user-bob", PHONE);
  await bob.waitForTimeout(600);
  await bob.screenshot({ path: `${OUT}/phone-feed.png` });

  // A decided card, so the ledger has something in it.
  await bob
    .getByRole("article", { name: /from Alice/ })
    .first()
    .getByRole("button", { name: /^Approve:/ })
    .click();
  await bob.waitForTimeout(500);
  await bob.screenshot({ path: `${OUT}/phone-feed-decided.png` });

  await bob.getByRole("button", { name: "History" }).click();
  await bob.waitForTimeout(600);
  await bob.screenshot({ path: `${OUT}/phone-ledger.png`, fullPage: true });

  await bob.getByRole("button", { name: "Channels" }).click();
  await bob.waitForTimeout(400);
  await bob.screenshot({ path: `${OUT}/phone-channels.png` });

  await bob.getByRole("button", { name: "⚙" }).click();
  await bob.waitForTimeout(400);
  await bob.screenshot({ path: `${OUT}/phone-settings.png`, fullPage: true });

  // The same feed in light, from a fresh context so the OS preference drives it.
  const light = await signIn(browser, "user-bob", PHONE, "light");
  await light.waitForTimeout(600);
  await light.screenshot({ path: `${OUT}/phone-feed-light.png` });

  const desk = await signIn(browser, "user-bob", DESKTOP);
  await desk.waitForTimeout(700);
  await desk.screenshot({ path: `${OUT}/desktop-workbench.png` });

  await desk.getByRole("button", { name: "History" }).click();
  await desk.waitForTimeout(600);
  await desk.screenshot({ path: `${OUT}/desktop-ledger.png` });

  await desk.keyboard.press("ControlOrMeta+k");
  await desk.waitForTimeout(300);
  await desk.screenshot({ path: `${OUT}/desktop-palette.png` });
});

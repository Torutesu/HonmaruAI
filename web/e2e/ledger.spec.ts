import { expect, test } from "@playwright/test";

// The ledger reads the same store the feed does, so by the time this runs the
// earlier specs have already put real decisions in it — no fixtures needed.

test("the ledger is the decision history, searchable and measured", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("/auth/dev?user=user-bob");

  await page.getByRole("button", { name: "History" }).click();

  // The stats come from the decisions the other specs made.
  await expect(page.getByText("Decided", { exact: true })).toBeVisible();
  await expect(page.getByText("time to decide")).toBeVisible();

  const entries = page.getByRole("listitem");
  await expect(entries.first()).toBeVisible();
  const total = await entries.count();

  // Searching narrows it; a query nothing matches says so rather than
  // silently showing everything.
  await page.getByRole("textbox", { name: "Search decisions" }).fill("vendor");
  await expect(entries.first()).toContainText(/vendor/i);

  await page.getByRole("textbox", { name: "Search decisions" }).fill("zzzznothing");
  await expect(page.getByText(/Nothing matches/)).toBeVisible();

  await page.getByRole("textbox", { name: "Search decisions" }).fill("");
  await expect(entries).toHaveCount(total);

  // Pending items have no lead time — the ledger shows a dash, not a zero.
  await page.getByRole("button", { name: "pending" }).click();
  const first = entries.first();
  if (await first.isVisible()) {
    await expect(first).toContainText("Still open");
  }
});

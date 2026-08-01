import { expect, test } from "@playwright/test";

// Autopilot's behaviour is covered at the relay (it needs cards older than the
// hold window, which no browser test can wait for). What matters here is the
// surface that grants it authority: it must be off, it must be reachable, and
// it must show what will actually happen rather than what was asked for.

test("granting decision authority is explicit, and the relay's answer is what's shown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("/auth/dev?user=user-carol");

  await page.getByRole("button", { name: "⚙" }).click();

  const toggle = page.getByRole("button", { name: /you decide everything/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(
    page.getByRole("button", { name: /your AI can decide for you/ })
  ).toHaveAttribute("aria-pressed", "true");

  // Urgent is not offered as a ceiling — it always waits for a person.
  const ceilings = page.getByRole("button", { name: /^(low|medium|high)$/ });
  await expect(ceilings).toHaveCount(3);
  await expect(page.getByRole("button", { name: "urgent", exact: true })).toHaveCount(0);

  // Declining is a second, separate opt-in.
  const decline = page.getByRole("button", { name: /Let it decline too/ });
  await expect(decline).toHaveAttribute("aria-pressed", "false");

  // Turning it back off sticks across a reload — this is stored per person.
  await page.getByRole("button", { name: /your AI can decide for you/ }).click();
  await page.reload();
  await page.getByRole("button", { name: "⚙" }).click();
  await expect(page.getByRole("button", { name: /you decide everything/ })).toBeVisible();
});

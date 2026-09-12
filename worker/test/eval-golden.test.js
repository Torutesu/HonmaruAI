import { expect, test } from "vitest";
import { routeInstruction } from "../src/routing.js";
import golden from "../eval/golden.json";

// The keyword router is what answers when there is no model — a provider
// outage, an exhausted allowance, a key not yet set — and it is measured here
// so that a change to it cannot quietly send the wrong person a card. The
// number is the one `node eval/run.mjs` prints; the gate is set just under
// what the router does today, so a regression fails and an improvement is
// free to raise it.

const RECIPIENT_GATE = 0.9;

test("the local router names the right recipient on the golden set", async () => {
  let ok = 0;
  let n = 0;
  const misses = [];
  for (const entry of golden.entries) {
    const want = entry.expect?.recipientUserID;
    if (!want) continue;
    const org = golden.orgs[entry.org];
    const result = await routeInstruction({
      text: entry.text,
      sender: { ...entry.sender, name: entry.sender.id },
      organization: org,
      readerLanguage: entry.readerLanguage || "en",
    });
    n += 1;
    if (result.recipientUserID === want) ok += 1;
    else misses.push(`${entry.id}: got ${result.recipientUserID}, want ${want}`);
  }
  const accuracy = ok / n;
  expect(accuracy, `recipient accuracy ${ok}/${n}; misses: ${misses.join("; ")}`).toBeGreaterThanOrEqual(RECIPIENT_GATE);
});

test("every golden entry is well-formed", () => {
  for (const entry of golden.entries) {
    expect(entry.id).toBeTruthy();
    expect(golden.orgs[entry.org], `${entry.id} names an org fixture`).toBeTruthy();
    expect(typeof entry.text).toBe("string");
    expect(entry.sender?.id).toBeTruthy();
    const ids = new Set(golden.orgs[entry.org].nodes.map((node) => node.id));
    if (entry.expect?.recipientUserID) {
      expect(ids.has(entry.expect.recipientUserID), `${entry.id} expects a member`).toBe(true);
    }
  }
});

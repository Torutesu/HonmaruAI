import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { loadStore, saveCard, removeCard } from "../src/db.js";
import schemaSql from "../schema.sql?raw";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("saveCard then loadStore round-trips a card into legacy shape", async () => {
  await saveCard(env.DB, "core-team", {
    id: "c1", recipientUserID: "user-yui", senderUserID: "user-toru",
    title: "Ship it?", priority: "high", createdAt: "2026-08-08T00:00:00Z",
  });
  const store = await loadStore(env.DB, "core-team");
  expect(store["user-yui"]).toHaveLength(1);
  expect(store["user-yui"][0].title).toBe("Ship it?");
  await removeCard(env.DB, "core-team", "c1");
  const after = await loadStore(env.DB, "core-team");
  expect(after["user-yui"]).toBeUndefined();
});

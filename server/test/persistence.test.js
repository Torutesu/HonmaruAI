import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedStores, createPersister } from "../persistence.js";

test("round-trips org stores through disk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "relay-store-")), "cards.json");
  const stores = new Map([
    ["core-team", { "user-alice": [{ id: "card-1", title: "Test" }] }],
  ]);

  const persister = createPersister(path);
  persister.flushNow(stores);

  const loaded = loadPersistedStores(path);
  assert.ok(loaded instanceof Map);
  assert.deepEqual(loaded.get("core-team"), stores.get("core-team"));
});

test("returns null for a missing file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "relay-store-")), "missing.json");
  assert.equal(loadPersistedStores(path), null);
});

test("returns null for corrupt JSON instead of crashing", () => {
  const path = join(mkdtempSync(join(tmpdir(), "relay-store-")), "corrupt.json");
  writeFileSync(path, "{not json");
  assert.equal(loadPersistedStores(path), null);
});

test("debounced writes coalesce into the latest state", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "relay-store-")), "cards.json");
  const stores = new Map([["core-team", {}]]);
  const persister = createPersister(path, { delayMs: 20 });

  persister.schedule(stores);
  stores.get("core-team")["user-bob"] = [{ id: "card-2" }];
  persister.schedule(stores);

  await new Promise((resolve) => setTimeout(resolve, 60));
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(written["core-team"]["user-bob"], [{ id: "card-2" }]);
});

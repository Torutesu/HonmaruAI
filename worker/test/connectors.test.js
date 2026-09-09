import { expect, test } from "vitest";
import { CONNECTORS, connectorById } from "../src/connectors/index.js";

test("every connector satisfies the contract", () => {
  expect(CONNECTORS.length).toBeGreaterThanOrEqual(2);
  for (const c of CONNECTORS) {
    expect(typeof c.id).toBe("string");
    expect(typeof c.label).toBe("string");
    expect(typeof c.toolSlug).toBe("string");
    // A connector either ships an auth config created at Composio, or declares
    // null — "not offered on a deployment that has not named one". Both are
    // the contract; anything else is a typo that reaches Composio as a request
    // it answers with something about a malformed body.
    expect(c.authConfigId === null || typeof c.authConfigId === "string").toBe(true);
    expect(typeof c.buildArgs).toBe("function");
    expect(typeof c.parse).toBe("function");
    expect(c.parse({})).toEqual([]);
  }
});

test("connectors are addressable by id", () => {
  expect(connectorById("gmail").label).toBe("Gmail");
  expect(connectorById("slack").label).toBe("Slack");
  expect(connectorById("nope")).toBeNull();
});

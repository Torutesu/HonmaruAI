import { expect, test } from "vitest";
import { CONNECTORS, connectorById } from "../src/connectors/index.js";

test("every connector satisfies the contract", () => {
  expect(CONNECTORS.length).toBeGreaterThanOrEqual(2);
  for (const c of CONNECTORS) {
    expect(typeof c.id).toBe("string");
    expect(typeof c.label).toBe("string");
    expect(typeof c.toolSlug).toBe("string");
    expect(typeof c.authConfigId).toBe("string");
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

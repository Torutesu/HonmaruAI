import { describe, expect, test } from "vitest";
import { CONNECTORS, connectorById, authConfigFor } from "../src/connectors/index.js";

// An auth config belongs to whoever created it at Composio. Shipping the ids
// this project set up is what makes a fresh deployment work with no
// configuration; not being able to override them is what makes anyone else's
// deployment impossible.
describe("which Composio auth config a connector uses", () => {
  test("the built-in default stands when nothing is set", () => {
    for (const c of CONNECTORS) {
      expect(authConfigFor({}, c)).toBe(c.authConfigId || null);
      expect(authConfigFor(undefined, c)).toBe(c.authConfigId || null);
    }
  });

  test("a named override wins", () => {
    const gmail = connectorById("gmail");
    expect(authConfigFor({ CONNECTOR_AUTH_GMAIL: "ac_mine" }, gmail)).toBe("ac_mine");
  });

  test("an override for one connector does not leak into another", () => {
    const slack = connectorById("slack");
    expect(authConfigFor({ CONNECTOR_AUTH_GMAIL: "ac_mine" }, slack)).toBe(slack.authConfigId);
  });

  test("a blank or whitespace value is not an override", () => {
    // A secret set to nothing is the shape a mistyped setup leaves behind, and
    // sending an empty auth config to Composio fails in a way that reads like
    // the connector itself is broken.
    const notion = connectorById("notion");
    expect(authConfigFor({ CONNECTOR_AUTH_NOTION: "" }, notion)).toBe(notion.authConfigId);
    expect(authConfigFor({ CONNECTOR_AUTH_NOTION: "   " }, notion)).toBe(notion.authConfigId);
  });

  test("every connector declares what the sync loop needs", () => {
    for (const c of CONNECTORS) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.label).toBe("string");
      // Either an id created at Composio, or null meaning "not offered until
      // someone sets CONNECTOR_AUTH_* for it" — never anything else.
      expect(c.authConfigId === null || /^ac_/.test(c.authConfigId)).toBe(true);
      expect(typeof c.toolSlug).toBe("string");
      expect(typeof c.buildArgs).toBe("function");
      expect(typeof c.parse).toBe("function");
    }
  });
});

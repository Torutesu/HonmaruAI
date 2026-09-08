import { describe, expect, test } from "vitest";
import { googlecalendar } from "../src/connectors/googlecalendar.js";
import { googledrive } from "../src/connectors/googledrive.js";
import {
  CONNECTORS, availableConnectors, authConfigFor, toolSlugFor,
} from "../src/connectors/index.js";

// Composio wraps a tool's payload two different ways depending on the execution
// path, and every connector here has to survive both plus an empty result.
// These are the shapes, not a live call: the tool slugs and the Google response
// bodies are what the APIs document, and nothing here has been run against a
// real Composio key. That is why the slug is overridable — see toolSlugFor.
const wrap = (data) => ({ results: [{ response: { data } }] });
const plain = (data) => ({ data });

describe("Google Calendar", () => {
  const invitation = {
    id: "evt-1",
    summary: "Supplier review",
    start: { dateTime: "2026-09-10T09:00:00Z" },
    location: "Room 2",
    organizer: { displayName: "Kenji" },
    attendees: [{ self: true, responseStatus: "needsAction" }, { email: "other@x.com" }],
  };
  const alreadyAnswered = {
    ...invitation, id: "evt-2", summary: "Standup",
    attendees: [{ self: true, responseStatus: "accepted" }],
  };
  const declined = {
    ...invitation, id: "evt-3", summary: "Optional sync",
    attendees: [{ self: true, responseStatus: "declined" }],
  };

  test("both payload shapes, and an empty calendar", () => {
    expect(googlecalendar.parse(wrap({ items: [invitation] }))).toHaveLength(1);
    expect(googlecalendar.parse(plain({ items: [invitation] }))).toHaveLength(1);
    expect(googlecalendar.parse({ items: [invitation] })).toHaveLength(1);
    expect(googlecalendar.parse(plain({ items: [] }))).toEqual([]);
    expect(googlecalendar.parse({})).toEqual([]);
    expect(googlecalendar.parse(null)).toEqual([]);
  });

  test("an invitation you have not answered is what comes through", () => {
    const [card] = googlecalendar.parse(plain({ items: [invitation] }));
    expect(card.id).toBe("evt-1");
    expect(card.subject).toBe("Supplier review");
    expect(card.from).toBe("Kenji");
    expect(card.date).toBe("2026-09-10T09:00:00Z");
    // The snippet is all triage reads, so it must carry the reason this is a
    // decision rather than a diary entry.
    expect(card.snippet).toContain("not yet answered");
    expect(card.snippet).toContain("Room 2");
  });

  test("anything you already answered is not waiting on you", () => {
    // Declined counts: that was an answer. A calendar re-listing every meeting
    // you ever accepted is the noise this product exists to remove.
    const out = googlecalendar.parse(plain({ items: [invitation, alreadyAnswered, declined] }));
    expect(out.map((c) => c.id)).toEqual(["evt-1"]);
  });

  test("an event with no attendee list at all still comes through", () => {
    // Something put straight in your calendar has no attendees; it has not been
    // answered either, so it is a decision until triage says otherwise.
    const out = googlecalendar.parse(plain({ items: [{ id: "e", summary: "Hold", start: { date: "2026-09-11" } }] }));
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-09-11");
  });
});

describe("Google Drive", () => {
  const doc = {
    id: "file-1",
    name: "Supplier terms",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-09-08T04:00:00Z",
    webViewLink: "https://docs.google.com/document/d/file-1",
    owners: [{ displayName: "Mai", me: false }, { displayName: "You", me: true }],
    lastModifyingUser: { displayName: "Mai" },
  };

  test("both payload shapes, and an empty drive", () => {
    expect(googledrive.parse(wrap({ files: [doc] }))).toHaveLength(1);
    expect(googledrive.parse(plain({ files: [doc] }))).toHaveLength(1);
    expect(googledrive.parse({ files: [] })).toEqual([]);
    expect(googledrive.parse(null)).toEqual([]);
  });

  test("the person who shared it is the other owner, not you", () => {
    const [card] = googledrive.parse(plain({ files: [doc] }));
    expect(card.from).toBe("Mai");
    expect(card.subject).toBe("Supplier terms");
    expect(card.snippet).toContain("Doc shared with you");
    expect(card.date).toBe("2026-09-08T04:00:00Z");
  });

  test("an unknown mime type is still a file, not a crash", () => {
    const [card] = googledrive.parse(plain({ files: [{ id: "x", name: "thing.zip", mimeType: "application/zip" }] }));
    expect(card.snippet).toContain("File shared with you");
  });

  test("the query asks for what someone else put in front of you", () => {
    const q = googledrive.buildArgs().q;
    expect(q).toContain("sharedWithMe");
    expect(q).toContain("trashed = false");
    // A folder appearing is a container moving, not a request.
    expect(q).toContain("mimeType != 'application/vnd.google-apps.folder'");
  });
});

describe("what a deployment can actually offer", () => {
  test("a connector with no auth config is not listed", () => {
    // Offering it would be a Connect button that fails on press.
    const ids = availableConnectors({}).map((c) => c.id);
    expect(ids).toContain("gmail");
    expect(ids).not.toContain("googlecalendar");
    expect(ids).not.toContain("googledrive");
  });

  test("naming one at Composio is all it takes to switch it on", () => {
    const env = { CONNECTOR_AUTH_GOOGLECALENDAR: "ac_mine" };
    expect(availableConnectors(env).map((c) => c.id)).toContain("googlecalendar");
    expect(authConfigFor(env, googlecalendar)).toBe("ac_mine");
    // And still not Drive: one override does not switch on the other.
    expect(availableConnectors(env).map((c) => c.id)).not.toContain("googledrive");
  });

  test("a renamed tool slug is a secret, not a release", () => {
    expect(toolSlugFor({}, googledrive)).toBe(googledrive.toolSlug);
    expect(toolSlugFor({ CONNECTOR_TOOL_GOOGLEDRIVE: "GOOGLEDRIVE_FIND_FILE" }, googledrive))
      .toBe("GOOGLEDRIVE_FIND_FILE");
  });

  test("every connector still declares what the sync loop needs", () => {
    for (const c of CONNECTORS) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.label).toBe("string");
      expect(typeof c.toolSlug).toBe("string");
      expect(typeof c.buildArgs).toBe("function");
      expect(typeof c.parse).toBe("function");
      // Every parse must survive nonsense rather than throwing inside the loop.
      expect(c.parse(null)).toEqual([]);
      expect(c.parse({})).toEqual([]);
    }
  });
});

import { expect, test } from "vitest";
import { parseMessages } from "../src/gmail.js";

const message = {
  messageId: "m1",
  threadId: "t1",
  subject: "Invoice #42 needs approval",
  sender: "billing@acme.com",
  preview: { body: "Please approve the attached invoice by Friday." },
  messageTimestamp: "2026-08-09T01:00:00Z",
};

test("parses the verified envelope", () => {
  const items = parseMessages({ successful: true, data: { messages: [message] } });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "m1", from: "billing@acme.com", subject: "Invoice #42 needs approval" });
  expect(items[0].snippet).toContain("approve the attached invoice");
});

test("parses the wrapped results envelope", () => {
  const items = parseMessages({ results: [{ response: { data: { messages: [message] } } }] });
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe("m1");
});

test("an empty inbox is a valid result, not an error", () => {
  expect(parseMessages({ data: { messages: [] } })).toEqual([]);
  expect(parseMessages({})).toEqual([]);
});

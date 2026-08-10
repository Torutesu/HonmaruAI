import { expect, test } from "vitest";
import { slack } from "../src/connectors/slack.js";

const match = {
  text: "Can you approve the deploy tonight?",
  username: "hubot",
  user: "U123",
  channel: { id: "C1", name: "release" },
  ts: "1754800000.123456",
  permalink: "https://acme.slack.com/archives/C1/p1754800000123456",
  iid: "search-result-id",
};

test("parses matches nested under messages.matches", () => {
  const items = slack.parse({ successful: true, data: { messages: { matches: [match] } } });
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe(match.permalink);
  expect(items[0].from).toBe("hubot");
  expect(items[0].subject).toBe("#release");
  expect(items[0].snippet).toContain("approve the deploy");
  expect(items[0].date).toBe(new Date(1754800000123).toISOString());
});

test("falls back to channel and ts when there is no permalink", () => {
  const { permalink, ...noLink } = match;
  const items = slack.parse({ data: { messages: { matches: [noLink] } } });
  expect(items[0].id).toBe("C1-1754800000.123456");
});

test("no matches is a valid result", () => {
  expect(slack.parse({ data: { messages: { matches: [] } } })).toEqual([]);
  expect(slack.parse({})).toEqual([]);
});

test("buildArgs asks Slack for what is addressed to me", () => {
  const args = slack.buildArgs();
  expect(args.query).toMatch(/^to:me after:\d{4}-\d{2}-\d{2}$/);
  expect(args.sort).toBe("timestamp");
});

import test from "node:test";
import assert from "node:assert/strict";
import { extractLinkSources, buildSources } from "../provenance.js";
import { createChannelStore } from "../channels.js";

test("extractLinkSources labels known domains and GitHub PRs/issues", () => {
  const sources = extractLinkSources(
    "Spec: https://notion.so/spec-123, mocks https://www.figma.com/file/abc and https://github.com/torutesu/honmaruai/pull/12."
  );
  assert.deepEqual(
    sources.map((s) => s.label),
    ["Notion", "Figma", "PR #12"]
  );
  // trailing punctuation stripped
  assert.ok(sources[2].url.endsWith("/pull/12"));
});

test("extractLinkSources: unknown domains use hostname, dedupes, caps at 4", () => {
  const many = extractLinkSources(
    "https://example.com/a https://example.com/a https://docs.google.com/x " +
      "https://one.io https://two.io https://three.io"
  );
  assert.equal(many.length, 4);
  assert.equal(many[0].label, "example.com");
  assert.equal(many[1].label, "Google Docs");
  assert.deepEqual(extractLinkSources("no links here"), []);
});

test("buildSources: channel conversation first, then referenced docs", () => {
  const store = createChannelStore(null);
  const card = {
    channelID: "channel-general",
    sourceMessageID: "msg-1",
    sourceInstruction: "Review the spec https://notion.so/spec-123",
    summary: "s",
    context: "c",
  };
  const sources = buildSources({ card, channelStore: store });
  assert.equal(sources[0].kind, "channel");
  assert.equal(sources[0].label, "#general");
  assert.equal(sources[0].messageID, "msg-1");
  assert.equal(sources[1].label, "Notion");
});

test("buildSources: webhook origin URL is a source, created issue is not", () => {
  const store = createChannelStore(null);

  const webhookCard = {
    githubIssueURL: "https://github.com/torutesu/honmaruai/pull/12",
    summary: "review request",
    context: "",
  };
  const webhookSources = buildSources({ card: webhookCard, channelStore: store });
  assert.equal(webhookSources[0].label, "PR #12");

  const createdIssueCard = {
    githubIssueURL: "https://github.com/torutesu/honmaruai/issues/5",
    githubIssueNumber: 5,
    summary: "s",
    context: "",
  };
  assert.equal(buildSources({ card: createdIssueCard, channelStore: store }), undefined);
});

import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, until } from "./helpers.js";
import { jamState, iceServers, transcriptMessage } from "../src/jam.js";

// A Jam: the relay introduces the browsers in it and passes their offers,
// answers and candidates between them; everyone who can see the channel is
// told who is talking; the channel hears when it starts and ends.

const ORG = "jam-team";
const custom = (name, pred = () => true) => (m) => m.type === "CUSTOM" && m.name === name && pred(m.value);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM channel_messages;");
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "2001", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "2002", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "2003", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  for (const id of ["2001", "2002", "2003"]) await upsertMembership(env.DB, ORG, id, "member");
  globalThis.__jamT = await createSession(env.DB, "2001", "gho_1");
  globalThis.__jamM = await createSession(env.DB, "2002", "gho_2");
  globalThis.__jamK = await createSession(env.DB, "2003", "gho_3");
});

test("two people in a Jam are introduced, pass signals, and the channel hears it start and end", async () => {
  const toru = await joined(ORG, globalThis.__jamT);
  const mika = await joined(ORG, globalThis.__jamM);
  const kenji = await joined(ORG, globalThis.__jamK);

  toru.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "b:general", mode: "full" } }));
  const first = await message(toru.messages, custom("jam_joined"));
  expect(first.value).toMatchObject({ channel: "b:general", peers: [], mode: "full", transport: "mesh" });
  expect(first.value.iceServers[0].urls).toContain("stun:stun.cloudflare.com:3478");

  // Everyone who can see the channel is told, and the channel hears it.
  const seen = await message(kenji.messages, custom("jam_state", (v) => v.active && v.participants.length === 1));
  expect(seen.value).toMatchObject({ channel: "b:general", mode: "full", recorderPeerId: first.value.peerId });
  expect(seen.value.participants[0]).toMatchObject({ name: "Toru", muted: false });
  const started = await message(kenji.messages, custom("channel_message", (v) => v.message?.kind === "ai"));
  // In the language of whoever started it.
  expect(started.value.message.body).toBe("ToruさんがJamを始めました。");

  mika.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "b:general", mode: "off", muted: true } }));
  const second = await message(mika.messages, custom("jam_joined"));
  // The Jam keeps the mode it started with; the newcomer calls those in it.
  expect(second.value).toMatchObject({ peers: [first.value.peerId], mode: "full" });

  mika.ws.send(JSON.stringify({ type: "jam_signal", payload: { to: first.value.peerId, data: { sdp: { type: "offer", sdp: "v=0" } } } }));
  const offer = await message(toru.messages, custom("jam_signal"));
  expect(offer.value).toEqual({ from: second.value.peerId, data: { sdp: { type: "offer", sdp: "v=0" } } });
  // Nobody else hears a signal meant for one.
  expect(kenji.messages.some(custom("jam_signal"))).toBe(false);

  const two = await message(kenji.messages, custom("jam_state", (v) => v.participants.length === 2));
  expect(two.value.participants.map((p) => [p.name, p.muted])).toEqual([["Toru", false], ["Mika", true]]);

  mika.ws.send(JSON.stringify({ type: "jam_mute", payload: { muted: false } }));
  await message(kenji.messages, custom("jam_state", (v) => v.participants.length === 2 && !v.participants[1].muted));

  // Toru leaves; Mika — now the earliest — records from here.
  toru.ws.send(JSON.stringify({ type: "jam_leave", payload: {} }));
  const left = await message(kenji.messages, custom("jam_state", (v) => v.participants.length === 1 && v.participants[0].name === "Mika"));
  expect(left.value.recorderPeerId).toBe(second.value.peerId);

  // The last one out — by closing the tab — ends it.
  mika.ws.close(1000, "bye");
  const ended = await message(kenji.messages, custom("jam_state", (v) => !v.active));
  expect(ended.value.participants).toEqual([]);
  const said = await until(async () => env.DB.prepare(
    "SELECT body FROM channel_messages WHERE org_id = ?1 AND channel = 'b:general' AND body LIKE 'Jam%'"
  ).bind(ORG).first());
  expect(said.body).toMatch(/^Jam ended · \d+ min · Toru, Mika$/);
});

test("a direct conversation's Jam is only the two people's", async () => {
  const toru = await joined(ORG, globalThis.__jamT);
  const kenji = await joined(ORG, globalThis.__jamK);
  // A channel that does not resolve is refused, in words.
  toru.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "dm:nobody" } }));
  const refused = await message(toru.messages, custom("jam_error"));
  expect(refused.value.message).toBe("No such channel.");
  expect(kenji.messages.some(custom("jam_state"))).toBe(false);
});

test("a signal before joining goes nowhere", async () => {
  const toru = await joined(ORG, globalThis.__jamT);
  const mika = await joined(ORG, globalThis.__jamM);
  mika.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "b:ops" } }));
  const joinedMika = await message(mika.messages, custom("jam_joined"));
  toru.ws.send(JSON.stringify({ type: "jam_signal", payload: { to: joinedMika.value.peerId, data: { candidate: {} } } }));
  // Toru was never in it: nothing reaches Mika. A later join proves the
  // relay went on working.
  toru.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "b:ops" } }));
  await message(toru.messages, custom("jam_joined"));
  expect(mika.messages.some(custom("jam_signal"))).toBe(false);
  toru.ws.send(JSON.stringify({ type: "jam_leave", payload: {} }));
  mika.ws.send(JSON.stringify({ type: "jam_leave", payload: {} }));
  await message(toru.messages, custom("jam_state", (v) => v.channel === "b:ops" && !v.active));
});

test("a Jam as it is told: earliest first, recorded by the earliest unless it is not recorded", () => {
  const peer = (userId, since, jam = {}) => ({ att: { userId, jam: { peerId: `p-${userId}`, since, muted: false, mode: "notes", ...jam } } });
  const members = [{ login: "a", name: "A", ref: "r-a" }, { login: "b", name: "B", ref: "r-b" }];
  const state = jamState([peer("a", "1"), peer("b", "2", { muted: true })], members, { startedAt: "0", mode: "notes" });
  expect(state).toEqual({
    active: true,
    transport: "mesh",
    participants: [
      { peerId: "p-a", ref: "r-a", name: "A", muted: false, since: "1", video: false, screen: false, avatarUrl: null },
      { peerId: "p-b", ref: "r-b", name: "B", muted: true, since: "2", video: false, screen: false, avatarUrl: null },
    ],
    startedAt: "0",
    mode: "notes",
    recorderPeerId: "p-a",
    messageId: null,
  });
  expect(jamState([peer("a", "1")], members, { mode: "off" }).recorderPeerId).toBe(null);
  expect(jamState([], members, null)).toMatchObject({ active: false, startedAt: null, recorderPeerId: null });
});

test("TURN is offered when the deployment has one", async () => {
  const servers = await iceServers({ JAM_TURN_URLS: "turn:turn.example.com:3478, turns:turn.example.com:5349", JAM_TURN_USERNAME: "u", JAM_TURN_CREDENTIAL: "p" });
  expect(servers[1]).toEqual({ urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"], username: "u", credential: "p" });
  expect(await iceServers({})).toHaveLength(1);
});

test("a camera, a shared screen, a reaction and a live transcript go to everyone; the transcript is kept for the thread", async () => {
  const toru = await joined(ORG, globalThis.__jamT);
  const mika = await joined(ORG, globalThis.__jamM);
  const kenji = await joined(ORG, globalThis.__jamK);
  toru.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "b:design", mode: "off" } }));
  const first = await message(toru.messages, custom("jam_joined"));
  // The Jam's own message: its thread is where the transcript goes.
  const started = await message(kenji.messages, custom("jam_state", (v) => v.channel === "b:design" && v.messageId));
  expect(started.value.messageId).toBeTruthy();

  toru.ws.send(JSON.stringify({ type: "jam_media", payload: { video: true, screen: true } }));
  const shown = await message(kenji.messages, custom("jam_state", (v) => v.participants[0]?.screen));
  expect(shown.value.participants[0]).toMatchObject({ video: true, screen: true });

  toru.ws.send(JSON.stringify({ type: "jam_react", payload: { emoji: "👏" } }));
  const clap = await message(kenji.messages, custom("jam_reaction"));
  expect(clap.value).toMatchObject({ channel: "b:design", peerId: first.value.peerId, name: "Toru", emoji: "👏" });
  // Not an emoji: nothing.
  toru.ws.send(JSON.stringify({ type: "jam_react", payload: { emoji: "<img>" } }));

  toru.ws.send(JSON.stringify({ type: "jam_transcript", payload: { text: "Let's ship on Friday", final: true } }));
  const line = await message(kenji.messages, custom("jam_transcript", (v) => v.final));
  expect(line.value).toMatchObject({ channel: "b:design", name: "Toru", text: "Let's ship on Friday" });

  // Joined late: what was said so far comes with the welcome.
  mika.ws.send(JSON.stringify({ type: "jam_join", payload: { channel: "b:design" } }));
  const late = await message(mika.messages, custom("jam_joined", (v) => v.channel === "b:design"));
  expect(late.value.transcript.map((l) => l.text)).toEqual(["Let's ship on Friday"]);
  expect(late.value.messageId).toBe(started.value.messageId);

  // Ended: the transcript is a reply under the Jam's message.
  toru.ws.send(JSON.stringify({ type: "jam_leave", payload: {} }));
  mika.ws.send(JSON.stringify({ type: "jam_leave", payload: {} }));
  const reply = await until(async () => env.DB.prepare(
    "SELECT body FROM channel_messages WHERE org_id = ?1 AND parent_id = ?2"
  ).bind(ORG, started.value.messageId).first());
  expect(reply.body).toContain("Toru: Let's ship on Friday");
  expect(clap.value.emoji).toBe("👏");
});

test("a transcript message names each speaker and stays inside a message's length", () => {
  const body = transcriptMessage("en", [{ name: "A", text: "hi" }, { name: "B", text: "x".repeat(20000) }]);
  expect(body.startsWith("*Transcript*\nA: hi\nB: ")).toBe(true);
  expect(body.length).toBeLessThanOrEqual(8000);
});

import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import { sfuRequest, sfuReady, jamState, MAX_SFU_PEERS, MAX_JAM_PEERS } from "../src/jam.js";

// A Jam through the SFU: the browser asks through its socket, the relay
// holds the app's secret, and a browser pulls only what someone in its own
// Jam has published.

const ENV = { CF_CALLS_APP_ID: "app123", CF_CALLS_APP_SECRET: "s3cret" };
const CALLS = "https://rtc.live.cloudflare.com";
const calls = () => fetchMock.get(CALLS);

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("the SFU is used only with an app, and holds more than a mesh", () => {
  expect(sfuReady({})).toBe(false);
  expect(sfuReady(ENV)).toBe(true);
  expect(MAX_SFU_PEERS).toBeGreaterThan(MAX_JAM_PEERS);
});

test("push: a session is made once, the offer goes with the secret, and the tracks are remembered", async () => {
  const seen = [];
  calls().intercept({ path: "/v1/apps/app123/sessions/new", method: "POST", headers: { authorization: "Bearer s3cret" } })
    .reply(201, { sessionId: "sess-a" });
  calls().intercept({ path: "/v1/apps/app123/sessions/sess-a/tracks/new", method: "POST" })
    .reply((opts) => { seen.push(JSON.parse(opts.body)); return { statusCode: 200, data: { sessionDescription: { type: "answer", sdp: "v=0 answer" }, tracks: [{ mid: "0", trackName: "audio" }] } }; });
  const out = await sfuRequest(ENV, { peerId: "p1" }, [], { op: "push", sdp: "v=0 offer", tracks: [{ mid: "0", trackName: "audio" }, { mid: "9", trackName: "../../etc" }] });
  expect(out.reply).toEqual({ sdp: "v=0 answer", type: "answer" });
  expect(out.jam).toMatchObject({ sfuSession: "sess-a", tracks: ["audio"] });
  expect(out.announce).toBe(true);
  // Only a named track of its own goes; nothing it made up.
  expect(seen[0].tracks).toEqual([{ location: "local", mid: "0", trackName: "audio" }]);
  expect(seen[0].sessionDescription).toEqual({ type: "offer", sdp: "v=0 offer" });
});

test("pull: only tracks someone in this Jam published; the SFU's offer comes back with who is on each mid", async () => {
  const seen = [];
  calls().intercept({ path: "/v1/apps/app123/sessions/sess-b/tracks/new", method: "POST" })
    .reply((opts) => {
      seen.push(JSON.parse(opts.body));
      return { statusCode: 200, data: { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "v=0 sfu-offer" }, tracks: [{ mid: "1", sessionId: "sess-a", trackName: "audio" }, { mid: "2", sessionId: "sess-a", trackName: "camera" }] } };
    });
  const peers = [{ peerId: "p1", sfuSession: "sess-a", tracks: ["audio", "camera"] }];
  const out = await sfuRequest(ENV, { peerId: "p2", sfuSession: "sess-b" }, peers, {
    op: "pull",
    tracks: [{ peerId: "p1", trackName: "audio" }, { peerId: "p1", trackName: "camera" }, { peerId: "p1", trackName: "screen" }, { peerId: "stranger", trackName: "audio" }],
  });
  expect(seen[0].tracks).toEqual([
    { location: "remote", sessionId: "sess-a", trackName: "audio" },
    { location: "remote", sessionId: "sess-a", trackName: "camera" },
  ]);
  expect(out.reply.renegotiate).toBe(true);
  expect(out.reply.sdp).toBe("v=0 sfu-offer");
  expect(out.reply.tracks).toEqual([
    { mid: "1", peerId: "p1", trackName: "audio", error: null },
    { mid: "2", peerId: "p1", trackName: "camera", error: null },
  ]);
  // Nothing anyone published: no call to the SFU at all.
  const none = await sfuRequest(ENV, { peerId: "p2", sfuSession: "sess-b" }, peers, { op: "pull", tracks: [{ peerId: "stranger", trackName: "audio" }] });
  expect(none.reply).toEqual({ tracks: [], renegotiate: false });
});

test("renegotiate sends the browser's answer; an SFU error is thrown, not passed on", async () => {
  calls().intercept({ path: "/v1/apps/app123/sessions/sess-b/renegotiate", method: "PUT" }).reply(200, {});
  expect((await sfuRequest(ENV, { sfuSession: "sess-b" }, [], { op: "renegotiate", sdp: "v=0 answer" })).reply).toEqual({ ok: true });
  calls().intercept({ path: "/v1/apps/app123/sessions/sess-b/renegotiate", method: "PUT" }).reply(400, { errorCode: "bad_sdp", errorDescription: "bad" });
  await expect(sfuRequest(ENV, { sfuSession: "sess-b" }, [], { op: "renegotiate", sdp: "x" })).rejects.toThrow("bad");
  await expect(sfuRequest(ENV, { sfuSession: "sess-b" }, [], { op: "drop-tables" })).rejects.toThrow();
});

test("the Jam's state says how it talks, and through the SFU what each person publishes", () => {
  const peers = [{ att: { userId: "toru", jam: { peerId: "p1", since: "1", transport: "sfu", tracks: ["audio"] } } }];
  const state = jamState(peers, [{ login: "toru", ref: "r1", name: "Toru" }], { transport: "sfu", mode: "off" });
  expect(state.transport).toBe("sfu");
  expect(state.participants[0].tracks).toEqual(["audio"]);
  const mesh = jamState([{ att: { userId: "toru", jam: { peerId: "p1", since: "1" } } }], [], null);
  expect(mesh.transport).toBe("mesh");
  expect(mesh.participants[0].tracks).toBeUndefined();
});

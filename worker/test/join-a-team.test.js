import { env } from "cloudflare:test";
import { afterAll, beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Joining a team you were invited to, when you already have an account.
//
// Every one of these used to fail silently. Signing up with a code worked;
// everything after that first day did not. The invite field is offered to
// anyone on the sign-in screen, the code was read, and then nothing happened
// to it — no membership, no error, and the code left unspent with nothing in
// either client able to redeem one.

const MAIL = { RESEND_API_KEY: "re_test" };

let sent = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.resend.com")) {
      const body = JSON.parse(init.body);
      sent.push({ ...body, to: body.to[0] });
      return new Response(JSON.stringify({ id: "queued" }), { status: 200 });
    }
    return realFetch(input, init);
  };
});

// One runtime for the whole suite (`singleWorker`), so a stubbed `fetch` left
// in place here is a stubbed `fetch` for every file that runs after this one —
// which is exactly how this file, on its own entirely green, turned five
// github-proxy tests red.
afterAll(() => { globalThis.fetch = realFetch; });

/// Sign in the way a person does: ask for a code, read the one that was
/// emailed, and hand it back. Returns whatever the verify said.
async function signIn(email, { name, inviteCode } = {}) {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const before = sent.length;
  const asked = await requestCode({ ...env, ...MAIL }, { email, locale: "en" });
  expect(asked.ok).toBe(true);
  const code = (sent[before].text.match(/\b\d{6}\b/) || [])[0];
  return verifyCode({ ...env, ...MAIL }, { email, code, name, inviteCode });
}

function inviteReq(token, body) {
  return new Request("https://example.com/invites/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify(body),
  });
}

async function mintInvite(token, orgId, role = "engineer") {
  const res = await worker.fetch(inviteReq(token, { orgId, role }), env);
  expect(res.status).toBe(200);
  return (await res.json()).code;
}

test("an invite handed to an account that already exists actually joins it", async () => {
  const { isMember } = await import("../src/db.js");
  const owner = await signIn("owner-a@honmaru.test", { name: "Owner" });
  const guest = await signIn("guest-a@honmaru.test", { name: "Guest" });
  expect(guest.created).toBe(true);
  expect(await isMember(env.DB, owner.orgId, guest.userId)).toBe(false);

  const code = await mintInvite(owner.token, owner.orgId);
  const again = await signIn("guest-a@honmaru.test", { inviteCode: code });

  expect(again.created).toBe(false);
  expect(again.inviteError).toBeUndefined();
  // The membership is the point; the orgId in the reply is what tells the
  // client which workspace to open, and it used to come back undefined.
  expect(await isMember(env.DB, owner.orgId, guest.userId)).toBe(true);
  expect(again.orgId).toBe(owner.orgId);
  // And at the role the code was minted for, not a flat "member".
  const row = await env.DB
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(owner.orgId, guest.userId).first();
  expect(row.role).toBe("engineer");
});

test("a bad invite costs the sign-in nothing, and says so", async () => {
  // The emailed code is the credential and it was right. Refusing the session
  // over a typo in a different field burns a single-use code on a mistake.
  await signIn("owner-b@honmaru.test", { name: "Owner" });
  await signIn("guest-b@honmaru.test", { name: "Guest" });
  const again = await signIn("guest-b@honmaru.test", { inviteCode: "0".repeat(32) });

  expect(again.error).toBeUndefined();
  expect(again.token).toBeTruthy();
  expect(again.inviteError).toBeTruthy();
});

test("signing in with nothing stored still says where you work", async () => {
  // A second browser has no orgId, and the reply used to carry none either —
  // so the client fell back to a placeholder org nobody is a member of, and
  // the relay refused the socket.
  const solo = await signIn("solo@honmaru.test", { name: "Solo" });
  const returning = await signIn("solo@honmaru.test");
  expect(returning.created).toBe(false);
  expect(returning.orgId).toBe(solo.orgId);
});

test("a team beats the workspace you were given at sign-up", async () => {
  const owner = await signIn("owner-c@honmaru.test", { name: "Owner" });
  const guest = await signIn("guest-c@honmaru.test", { name: "Guest" });
  const personal = guest.orgId;

  await signIn("guest-c@honmaru.test", { inviteCode: await mintInvite(owner.token, owner.orgId) });
  const returning = await signIn("guest-c@honmaru.test");

  // They are in both. The shared one is where the work is.
  expect(returning.orgId).toBe(owner.orgId);
  expect(returning.orgId).not.toBe(personal);
});

test("/me says which teams you are in, and who runs each", async () => {
  const owner = await signIn("owner-d@honmaru.test", { name: "Dana" });
  const guest = await signIn("guest-d@honmaru.test", { name: "Guest" });
  await signIn("guest-d@honmaru.test", { inviteCode: await mintInvite(owner.token, owner.orgId) });

  const res = await worker.fetch(
    new Request("https://example.com/me", { headers: { "x-session-token": guest.token } }),
    env
  );
  expect(res.status).toBe(200);
  const me = await res.json();
  const ids = me.orgs.map((o) => o.id);
  expect(ids).toContain(guest.orgId);
  expect(ids).toContain(owner.orgId);

  // A workspace called `personal:8f3a…` is not a name anyone can read, so the
  // person who started it stands in for one.
  const theirs = me.orgs.find((o) => o.id === guest.orgId);
  expect(theirs.mine).toBe(true);
  const joined = me.orgs.find((o) => o.id === owner.orgId);
  expect(joined.mine).toBe(false);
  expect(joined.founder).toBe("Dana");
  expect(joined.role).toBe("engineer");
});

test("routing will not describe a team you do not belong to", async () => {
  // /ai/route answers with a recipient and an agent route drawn from the org's
  // real membership rows. Every other route that reads an organization checks
  // that the caller is in it; this one did not, so any signed-in account could
  // name a repository org — they are all just "owner/repo" — and be told, by
  // name, who is on it.
  const owner = await signIn("owner-e@honmaru.test", { name: "Owner" });
  const outsider = await signIn("outsider-e@honmaru.test", { name: "Outsider" });

  const res = await worker.fetch(
    new Request("https://example.com/ai/route", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": outsider.token },
      body: JSON.stringify({
        text: "ask the engineer to fix the booking form",
        orgId: owner.orgId,
        sender: { id: "x", role: "member" },
      }),
    }),
    env
  );
  expect(res.status).toBe(403);
  expect(JSON.stringify(await res.json())).not.toContain("owner-e@honmaru.test");
});

test("routing still works inside your own team", async () => {
  const owner = await signIn("owner-f@honmaru.test", { name: "Owner" });
  const res = await worker.fetch(
    new Request("https://example.com/ai/route", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": owner.token },
      body: JSON.stringify({
        text: "decide whether to renew the lease",
        orgId: owner.orgId,
        sender: { id: owner.login, role: "admin" },
      }),
    }),
    env
  );
  expect(res.status).toBe(200);
  expect((await res.json()).recipientUserID).toBe(owner.login);
});

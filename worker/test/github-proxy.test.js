import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser } from "../src/db.js";

const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), env) };

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "5150", login: "octocat", name: "O", avatarUrl: "", locale: "en" });
  token = await createSession(env.DB, "5150", "gho_secret");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const call = (path, init = {}) =>
  SELF.fetch(`https://example.com/github${path}`, {
    ...init,
    headers: { "x-session-token": token, ...(init.headers || {}) },
  });

test("an allowed call is forwarded to GitHub as the session's user", async () => {
  let sentAuth = null;
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/user", method: "GET" })
    .reply(200, (opts) => { sentAuth = opts.headers.authorization; return { login: "octocat", id: 5150 }; });

  const res = await call("/user");
  expect(res.status).toBe(200);
  expect((await res.json()).login).toBe("octocat");
  // The token the app never sees is the one we use.
  expect(sentAuth).toBe("Bearer gho_secret");
});

test("creating an issue is forwarded with its body", async () => {
  let sentBody = null;
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/web/issues", method: "POST",
      body: (b) => { sentBody = JSON.parse(b); return true; } })
    .reply(201, { number: 7, html_url: "https://github.com/acme/web/issues/7" });

  const res = await call("/repos/acme/web/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Approve the deploy", body: "please" }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).number).toBe(7);
  expect(sentBody.title).toBe("Approve the deploy");
});

// This is the point of the allowlist. `repo` scope reaches the person's source;
// the app only ever opens issues, so that is all a stolen session can do.
test("anything the app does not do is refused, not forwarded", async () => {
  for (const [path, init] of [
    ["/repos/acme/web/contents/src/secrets.env", {}],
    ["/user/emails", {}],
    ["/repos/acme/web/collaborators", {}],
    ["/repos/acme/web/issues/7", { method: "DELETE" }],
    ["/gists", { method: "POST", body: "{}" }],
  ]) {
    const res = await call(path, init);
    expect(res.status, `${init.method || "GET"} ${path}`).toBe(404);
  }
});

test("a query parameter the rule does not name is dropped", async () => {
  let sentPath = null;
  fetchMock.get("https://api.github.com")
    .intercept({ path: (p) => { sentPath = p; return p.startsWith("/user/repos"); }, method: "GET" })
    .reply(200, []);

  await call("/user/repos?per_page=100&sort=updated&affiliation=organization_member");
  expect(sentPath).toContain("per_page=100");
  expect(sentPath).toContain("sort=updated");
  expect(sentPath).not.toContain("affiliation");
});

test("without a session there is no proxy at all", async () => {
  const res = await SELF.fetch("https://example.com/github/user");
  expect(res.status).toBe(401);
});


test("a decision's reason can be left on the issue as a comment", async () => {
  // Approving opened an issue and everything else did nothing: a decline left
  // it open with no explanation, and a revision note never arrived at all. An
  // engineer reading the tracker saw a request and no answer.
  let sentBody = null;
  fetchMock.get("https://api.github.com")
    .intercept({
      path: "/repos/acme/web/issues/7/comments", method: "POST",
      body: (b) => { sentBody = JSON.parse(b); return true; },
    })
    .reply(201, { id: 1 });

  const res = await call("/repos/acme/web/issues/7/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Declined by grace: the budget is already committed." }),
  });
  expect(res.status).toBe(201);
  expect(sentBody.body).toContain("Declined by grace");
});

test("the comment route does not widen into everything else under an issue", async () => {
  // `:number` matches one segment and never a slash, so the new rule cannot be
  // walked into a different endpoint.
  for (const path of [
    "/repos/acme/web/issues/7/labels",
    "/repos/acme/web/issues/7/comments/9",
    "/repos/acme/web/pulls/7/comments",
  ]) {
    const res = await call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  }
});

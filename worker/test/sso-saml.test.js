import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { SignedXml } from "xml-crypto";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { forgetPolicies } from "../src/policy.js";
import { parseIdpMetadata, verifyResponse } from "../src/saml.js";
import idpCert from "./fixtures/saml-idp.crt?raw";
import idpKeyBody from "./fixtures/saml-idp.key.b64?raw";
import otherCert from "./fixtures/saml-other.crt?raw";
import otherKeyBody from "./fixtures/saml-other.key.b64?raw";
import { sessionKey } from "../src/db.js";

// SAML 2.0, and a workspace with more than one identity provider
// (docs/sso-and-domain-join.md §11): a pretend IdP signs real assertions
// with its own certificate, and every check on them is exercised — the
// signature, what it covers, the audience, the recipient, the request it
// answers, the time — before anyone is signed in.

const ORG = "team:acme";
const IDP = "https://idp.acme.test/saml";
const IDP_SSO = "https://idp.acme.test/sso";
const pem = (body) => `-----BEGIN PRIVATE KEY-----\n${body.trim().match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const KEYS = { idp: pem(idpKeyBody), other: pem(otherKeyBody) };
const S = { samlp: "urn:oasis:names:tc:SAML:2.0:protocol", saml: "urn:oasis:names:tc:SAML:2.0:assertion" };
let owner;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body, form } = {}) => {
  const headers = { ...(token ? { "x-session-token": token } : {}) };
  let payload;
  if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
  else if (body) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, { method, redirect: "manual", headers, ...(payload ? { body: payload } : {}) }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const params = (res) => new URLSearchParams(res.headers.get("location").split("?")[1] || "");

const metadata = (entityId, ssoUrl, cert, slo = null) => `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert.replace(/-----[A-Z ]+-----|\s/g, "")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ssoUrl}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>${slo ? `
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${slo}"/>` : ""}
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

/// What the IdP posts back: an assertion for `email`, signed as asked.
function samlResponse(o) {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const {
    requestId, sp, email = "ken@acme.co.jp", issuer = IDP, audience = sp.entityId, recipient = sp.acs, inResponseTo = requestId,
    expiresIn = 300_000, key = "idp", algorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", sign = "assertion", status = "Success",
    sessionIndex = null, mail = null,
  } = o;
  const assertion = `<saml:Assertion xmlns:saml="${S.saml}" ID="_a1" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${inResponseTo}" Recipient="${recipient}" NotOnOrAfter="${iso(expiresIn)}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(expiresIn)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>${sessionIndex ? `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${sessionIndex}"/>` : ""}<saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Ken Sato</saml:AttributeValue></saml:Attribute>${mail ? `<saml:Attribute Name="mail"><saml:AttributeValue>${mail}</saml:AttributeValue></saml:Attribute>` : ""}</saml:AttributeStatement></saml:Assertion>`;
  let xml = `<samlp:Response xmlns:samlp="${S.samlp}" xmlns:saml="${S.saml}" ID="_r1" Version="2.0" IssueInstant="${iso(0)}" Destination="${sp.acs}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${status}"/></samlp:Status>${assertion}</samlp:Response>`;
  if (sign) {
    const target = sign === "assertion" ? "Assertion" : "Response";
    const sig = new SignedXml({ privateKey: KEYS[key], signatureAlgorithm: algorithm, canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
    sig.addReference({ xpath: `//*[local-name(.)='${target}']`, digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
    sig.computeSignature(xml, { location: { reference: `//*[local-name(.)='${target}']/*[local-name(.)='Issuer']`, action: "after" } });
    xml = sig.getSignedXml();
  }
  return o.mutate ? o.mutate(xml) : xml;
}
const encode = (xml) => btoa(String.fromCharCode(...new TextEncoder().encode(xml)));

/// Start a sign-in through a connection and read the AuthnRequest's ID.
async function start(connection, extra = "") {
  const res = await call(`/sso/start?orgId=${encodeURIComponent(ORG)}&connection=${connection}${extra}`);
  expect(res.status).toBe(302);
  const at = new URL(res.headers.get("location"));
  const deflated = Uint8Array.from(atob(at.searchParams.get("SAMLRequest")), (c) => c.charCodeAt(0));
  const xml = await new Response(new Blob([deflated]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  return { at, xml, requestId: xml.match(/ ID="([^"]+)"/)[1], relay: at.searchParams.get("RelayState") };
}

async function makeSaml(body) {
  const res = await call("/orgs/sso/connections", owner, { method: "POST", body: { orgId: ORG, provider: "saml", ...body } });
  const out = await res.json();
  expect(res.status, JSON.stringify(out)).toBe(201);
  return out.connection;
}
const activate = (id) => env.DB.prepare("UPDATE sso_connections SET status = 'active', tested_at = ?2 WHERE id = ?1").bind(id, new Date().toISOString()).run();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM org_domains; DELETE FROM org_sso; DELETE FROM sso_connections; DELETE FROM org_sso_policy; DELETE FROM sso_identities; DELETE FROM sso_states; DELETE FROM sso_handoffs;");
  forgetPolicies();
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name, role, email] of [["8101", "u:toru@acme.co.jp", "Toru", "owner", "toru@acme.co.jp"], ["8102", "u:root@outside.jp", "Root", "owner", "root@outside.jp"], ["8103", "u:aya@kobe.jp", "Aya", "member", "aya@kobe.jp"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind(id, email, new Date().toISOString()).run();
    await upsertMembership(env.DB, ORG, id, role);
  }
  for (const d of ["acme.co.jp", "kobe.jp"]) {
    await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES (?1, ?2, 't', ?3, '8101', ?3)").bind(d, ORG, new Date().toISOString()).run();
  }
  owner = await createSession(env.DB, "8101", "x");
});

test("IdP metadata is read for its entity ID, redirect address and signing certificate", () => {
  const md = parseIdpMetadata(metadata(IDP, IDP_SSO, idpCert));
  expect(md).toMatchObject({ entityId: IDP, ssoUrl: IDP_SSO });
  expect(md.cert).toContain("BEGIN CERTIFICATE");
  expect(() => parseIdpMetadata(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`)).toThrow(/DOCTYPE/);
  expect(() => parseIdpMetadata("<md:EntityDescriptor xmlns:md=\"urn:oasis:names:tc:SAML:2.0:metadata\" entityID=\"x\"/>")).toThrow(/no identity provider/);
});

test("a SAML sign-in: our metadata, the AuthnRequest by redirect, the signed assertion, and a session handed back", async () => {
  const conn = await makeSaml({ name: "Acme Okta", metadataXml: metadata(IDP, IDP_SSO, idpCert), allowedDomains: ["acme.co.jp"] });
  expect(conn).toMatchObject({ provider: "saml", issuer: IDP, ssoUrl: IDP_SSO, certificate: "set", status: "draft" });
  expect(conn.sp.acs).toBe(`https://api.example.com/sso/saml/${conn.id}/acs`);
  const md = await call(`/sso/saml/${conn.id}/metadata`);
  expect(md.headers.get("content-type")).toContain("samlmetadata");
  expect(await md.text()).toContain(`Location="${conn.sp.acs}"`);

  // The owner's test sign-in proves it, then it is switched on.
  const test = await (await call(`/orgs/sso/connections/${conn.id}/test`, owner, { method: "POST", body: { orgId: ORG } })).json();
  const testReq = new URL(test.url);
  expect(testReq.origin + testReq.pathname).toBe(IDP_SSO);
  expect((await call(`/orgs/sso/connections/${conn.id}/activate`, owner, { method: "POST", body: { orgId: ORG } })).status).toBe(400);
  await activate(conn.id);

  const { xml, requestId, relay } = await start(conn.id);
  expect(xml).toContain(`AssertionConsumerServiceURL="${conn.sp.acs}"`);
  expect(xml).toContain(`<saml:Issuer>${conn.sp.entityId}</saml:Issuer>`);
  const back = await call(`/sso/saml/${conn.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId, sp: conn.sp, email: "toru@acme.co.jp" })), RelayState: relay } });
  expect(back.status).toBe(302);
  const code = params(back).get("code");
  expect(code, back.headers.get("location")).toBeTruthy();
  const session = await (await call("/sso/exchange", null, { method: "POST", body: { code, client: "web" } })).json();
  expect(session.userId).toBe("8101");
  const row = await env.DB.prepare("SELECT auth_method, sso_org_id, sso_connection_id FROM sessions WHERE token = ?1").bind(await sessionKey(session.token)).first();
  expect(row).toEqual({ auth_method: "sso", sso_org_id: ORG, sso_connection_id: conn.id });
  // The same response again: its state is spent.
  const replay = await call(`/sso/saml/${conn.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId, sp: conn.sp })), RelayState: relay } });
  expect(params(replay).get("error")).toMatch(/expired|not started/);
});

test("every check on the assertion refuses what it should", async () => {
  const conn = await makeSaml({ metadataXml: metadata(IDP, IDP_SSO, idpCert), allowedDomains: ["acme.co.jp"] });
  const sp = conn.sp;
  const check = (o) => () => verifyResponse(encode(samlResponse({ requestId: "_req", sp, ...o })), { cert: parseIdpMetadata(metadata(IDP, IDP_SSO, idpCert)).cert, idpEntityId: IDP, spEntity: sp.entityId, acs: sp.acs, requestId: "_req" });
  expect(check({})()).toMatchObject({ email: "ken@acme.co.jp", name: "Ken Sato" });
  expect(check({ sign: "response" })()).toMatchObject({ email: "ken@acme.co.jp" });
  expect(check({ sign: null })).toThrow(/not signed/);
  expect(check({ key: "other" })).toThrow(/signature is not valid/);
  expect(check({ mutate: (x) => x.replace("ken@acme.co.jp</saml:NameID>", "boss@acme.co.jp</saml:NameID>") })).toThrow(/signature is not valid/);
  expect(check({ audience: "https://someone-else.test" })).toThrow(/different application/);
  expect(check({ recipient: "https://evil.test/acs" })).toThrow(/different address/);
  expect(check({ inResponseTo: "_other" })).toThrow(/does not answer/);
  expect(check({ issuer: "https://not-the-idp.test" })).toThrow(/different identity provider/);
  expect(check({ expiresIn: -600_000 })).toThrow(/expired/);
  expect(check({ status: "Requester" })).toThrow(/refused/);
  expect(check({ algorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1" })).toThrow(/not accepted/);
  expect(check({ mutate: (x) => `<!DOCTYPE r [<!ENTITY a "b">]>${x}` })).toThrow(/DOCTYPE/);
  // Signature wrapping: the signed assertion hidden away, and an unsigned
  // one of the attacker's carrying the signature in its place.
  expect(check({
    mutate: (x) => {
      const signed = x.match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)[0];
      const sigEl = signed.match(/<(ds:)?Signature[\s\S]*<\/(ds:)?Signature>/)[0];
      const evil = signed.replace(' ID="_a1"', ' ID="_evil"').replace(/ken@acme\.co\.jp/g, "boss@acme.co.jp");
      return x.replace(signed, `${evil}`).replace("<samlp:Status>", `<samlp:Extensions>${signed.replace(sigEl, "")}</samlp:Extensions><samlp:Status>`);
    },
  })).toThrow();
  // Two assertions, one signed and one not.
  expect(check({ mutate: (x) => x.replace("</samlp:Response>", `${x.match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)[0].replace(' ID="_a1"', ' ID="_a2"')}</samlp:Response>`) })).toThrow(/exactly one/);
});

test("another workspace naming the same SAML issuer cannot sign in as someone linked here", async () => {
  // Toru signs in through Acme's IdP once, and is linked.
  const acme = await makeSaml({ name: "Acme Okta", metadataXml: metadata(IDP, IDP_SSO, idpCert), allowedDomains: ["acme.co.jp"] });
  await activate(acme.id);
  const s = await start(acme.id);
  const first = await call(`/sso/saml/${acme.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId: s.requestId, sp: acme.sp, email: "toru@acme.co.jp" })), RelayState: s.relay } });
  expect((await (await call("/sso/exchange", null, { method: "POST", body: { code: params(first).get("code"), client: "web" } })).json()).userId).toBe("8101");

  // Somebody else's workspace, its own proved domain, the same issuer typed
  // in and a certificate of its own; its IdP says the subject is Toru's.
  const EVIL = "team:evil";
  const { createSession, upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, EVIL, "8102", "owner");
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('evil.test', ?1, 't', ?2, '8102', ?2)").bind(EVIL, new Date().toISOString()).run();
  const root = await createSession(env.DB, "8102", "z");
  const made = await call("/orgs/sso/connections", root, { method: "POST", body: { orgId: EVIL, provider: "saml", metadataXml: metadata(IDP, "https://evil.test/sso", otherCert), allowedDomains: ["evil.test"] } });
  const evil = (await made.json()).connection;
  await activate(evil.id);
  const res = await call(`/sso/start?orgId=${encodeURIComponent(EVIL)}&connection=${evil.id}`);
  const at = new URL(res.headers.get("location"));
  const deflated = Uint8Array.from(atob(at.searchParams.get("SAMLRequest")), (c) => c.charCodeAt(0));
  const requestId = (await new Response(new Blob([deflated]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text()).match(/ ID="([^"]+)"/)[1];
  const forged = await call(`/sso/saml/${evil.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId, sp: evil.sp, email: "toru@acme.co.jp", mail: "mallory@evil.test", key: "other" })), RelayState: at.searchParams.get("RelayState") } });
  const code = params(forged).get("code");
  const who = code ? (await (await call("/sso/exchange", null, { method: "POST", body: { code, client: "web" } })).json()).userId : null;
  expect(who).not.toBe("8101");
  // Toru's link and address are untouched.
  expect(await env.DB.prepare("SELECT org_id, email FROM sso_identities WHERE subject = 'toru@acme.co.jp'").first()).toEqual({ org_id: ORG, email: "toru@acme.co.jp" });
  expect((await env.DB.prepare("SELECT email FROM users WHERE github_id = '8101'").first()).email).toBe("toru@acme.co.jp");
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = '8101'").bind(EVIL).first()).toBeNull();
});

test("two identity providers, each for its own domains; one address, one way in", async () => {
  const acme = await makeSaml({ name: "Acme Okta", metadataXml: metadata(IDP, IDP_SSO, idpCert), allowedDomains: ["acme.co.jp"] });
  const kobe = await makeSaml({ name: "Kobe Entra", metadataXml: metadata("https://kobe.test/saml", "https://kobe.test/sso", otherCert), allowedDomains: ["kobe.jp"] });
  // A third over a domain already covered is refused.
  const clash = await call("/orgs/sso/connections", owner, { method: "POST", body: { orgId: ORG, provider: "saml", metadataXml: metadata("https://x.test", "https://x.test/sso", otherCert), allowedDomains: ["kobe.jp"] } });
  expect(clash.status).toBe(409);
  await activate(acme.id); await activate(kobe.id);
  const listed = await (await call(`/orgs/sso?orgId=${encodeURIComponent(ORG)}`, owner)).json();
  expect(listed.connections.map((c) => c.name)).toEqual(["Acme Okta", "Kobe Entra"]);

  // Each address is sent to its own provider.
  const discover = async (email) => (await (await call("/auth/discover", null, { method: "POST", body: { email } })).json()).sso;
  expect(await discover("ken@acme.co.jp")).toMatchObject({ connectionId: acme.id, providerName: "Acme Okta" });
  expect(await discover("aya@kobe.jp")).toMatchObject({ connectionId: kobe.id, providerName: "Kobe Entra" });
  const byEmail = await call(`/sso/start?orgId=${encodeURIComponent(ORG)}&email=aya@kobe.jp`);
  expect(new URL(byEmail.headers.get("location")).origin).toBe("https://kobe.test");

  // Kobe's assertion is not good at Acme's door, even signed by Kobe.
  const { requestId, relay } = await start(acme.id);
  const wrongDoor = await call(`/sso/saml/${kobe.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId, sp: kobe.sp, email: "aya@kobe.jp", issuer: "https://kobe.test/saml", key: "other" })), RelayState: relay } });
  expect(params(wrongDoor).get("error")).toMatch(/different connection/);

  // Required, after an SSO sign-in of the owner's own: both domains are held to it.
  const s = await start(acme.id);
  const back = await call(`/sso/saml/${acme.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId: s.requestId, sp: acme.sp, email: "toru@acme.co.jp" })), RelayState: s.relay } });
  const viaSso = (await (await call("/sso/exchange", null, { method: "POST", body: { code: params(back).get("code"), client: "web" } })).json()).token;
  const on = await call("/orgs/sso/enforce", viaSso, { method: "PUT", body: { orgId: ORG, enforce: true } });
  expect(on.status).toBe(200);
  expect((await on.json()).breakGlass).toBe(1);
  const { createSession } = await import("../src/db.js");
  const aya = await createSession(env.DB, "8103", "y");
  const refused = await call(`/members?orgId=${encodeURIComponent(ORG)}`, aya);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "sso-required", start: expect.stringContaining(`connection=${kobe.id}`) });
  // Turning Kobe's off leaves Acme required; Kobe's people are free again.
  await call(`/orgs/sso/connections/${kobe.id}?orgId=${encodeURIComponent(ORG)}`, viaSso, { method: "DELETE" });
  expect((await call(`/members?orgId=${encodeURIComponent(ORG)}`, aya)).status).toBe(200);
});

test("a workspace set up before there could be several keeps its connection and its rule", async () => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO org_sso (org_id, provider, issuer, client_id, client_secret, allowed_domains, enforce, enforce_since, session_hours, status, tested_at, created_by, updated_at)
     VALUES (?1, 'okta', 'https://old.test', 'c1', 'v1:x:y', '["acme.co.jp"]', 1, ?2, 12, 'active', ?2, '8101', ?2)`
  ).bind(ORG, now).run();
  // The owner at the domain is held to it at once; the break-glass owner looks.
  expect((await call(`/orgs/sso?orgId=${encodeURIComponent(ORG)}`, owner)).status).toBe(403);
  const { createSession } = await import("../src/db.js");
  const root = await createSession(env.DB, "8102", "z");
  const shown = await (await call(`/orgs/sso?orgId=${encodeURIComponent(ORG)}`, root)).json();
  expect(shown.connections).toHaveLength(1);
  expect(shown.connections[0]).toMatchObject({ id: expect.stringMatching(/^primary-/), provider: "okta", issuer: "https://old.test", status: "active", sessionHours: 12 });
  expect(shown.enforce).toBe(true);
  expect(shown.sso).toMatchObject({ issuer: "https://old.test", enforce: true });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM org_sso").first()).n).toBe(0);
});

// ---- Single logout: the IdP ends sign-ins here ----

const IDP_SLO = "https://idp.acme.test/slo";
let logoutSeq = 0;
function logoutRequest({ sp, nameId = "toru@acme.co.jp", sessionIndexes = [], issuer = IDP, destination = sp.slo, issued = Date.now() }) {
  logoutSeq += 1;
  return `<samlp:LogoutRequest xmlns:samlp="${S.samlp}" xmlns:saml="${S.saml}" ID="_lo${logoutSeq}" Version="2.0" IssueInstant="${new Date(issued).toISOString()}" Destination="${destination}"><saml:Issuer>${issuer}</saml:Issuer><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>${sessionIndexes.map((i) => `<samlp:SessionIndex>${i}</samlp:SessionIndex>`).join("")}</samlp:LogoutRequest>`;
}
function signPosted(xml, key = "idp") {
  const sig = new SignedXml({ privateKey: KEYS[key], signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
  sig.addReference({ xpath: "//*[local-name(.)='LogoutRequest']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='LogoutRequest']/*[local-name(.)='Issuer']", action: "after" } });
  return sig.getSignedXml();
}
/// The redirect binding: deflated, and the query itself signed.
async function signedRedirect(xml, { key = "idp", relay = "back-to-idp" } = {}) {
  const deflated = new Uint8Array(await new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const q = `SAMLRequest=${encodeURIComponent(btoa(String.fromCharCode(...deflated)))}&RelayState=${encodeURIComponent(relay)}&SigAlg=${encodeURIComponent("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256")}`;
  const der = Uint8Array.from(atob((key === "idp" ? idpKeyBody : otherKeyBody).trim()), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(q)));
  return `${q}&Signature=${encodeURIComponent(btoa(String.fromCharCode(...sig)))}`;
}
async function samlSession(conn, sessionIndex) {
  const { requestId, relay } = await start(conn.id);
  const back = await call(`/sso/saml/${conn.id}/acs`, null, { method: "POST", form: { SAMLResponse: encode(samlResponse({ requestId, sp: conn.sp, email: "toru@acme.co.jp", sessionIndex })), RelayState: relay } });
  return (await (await call("/sso/exchange", null, { method: "POST", body: { code: params(back).get("code"), client: "web" } })).json()).token;
}
const alive = async (token) => (await call(`/members?orgId=${encodeURIComponent(ORG)}`, token)).status === 200;

test("single logout by post: signed by the IdP, one sign-in or all of them, once, and answered to the IdP", async () => {
  const conn = await makeSaml({ metadataXml: metadata(IDP, IDP_SSO, idpCert, IDP_SLO), allowedDomains: ["acme.co.jp"] });
  expect(conn.sp.slo).toBe(`https://api.example.com/sso/saml/${conn.id}/slo`);
  expect(conn.idpSloUrl).toBe(IDP_SLO);
  expect(await (await call(`/sso/saml/${conn.id}/metadata`)).text()).toContain(`SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${conn.sp.slo}"`);
  await activate(conn.id);
  const a = await samlSession(conn, "_s1");
  const b = await samlSession(conn, "_s2");
  expect(await env.DB.prepare("SELECT sso_subject, sso_sid FROM sessions WHERE token = ?1").bind(await sessionKey(a)).first()).toEqual({ sso_subject: "toru@acme.co.jp", sso_sid: "_s1" });

  // Refused: unsigned, another key, another IdP, another address, stale.
  for (const xml of [
    logoutRequest({ sp: conn.sp, sessionIndexes: ["_s1"] }),
    signPosted(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s1"] }), "other"),
    signPosted(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s1"], issuer: "https://evil.test" })),
    signPosted(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s1"], destination: "https://elsewhere.test/slo" })),
    signPosted(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s1"], issued: Date.now() - 60 * 60_000 })),
  ]) {
    expect((await call(`/sso/saml/${conn.id}/slo`, null, { method: "POST", form: { SAMLRequest: encode(xml) } })).status).toBe(400);
  }
  expect(await alive(a)).toBe(true);

  // One sign-in, by its SessionIndex: that one ends, the other stays.
  const one = signPosted(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s1"] }));
  const done = await call(`/sso/saml/${conn.id}/slo`, null, { method: "POST", form: { SAMLRequest: encode(one), RelayState: "r1" } });
  expect(done.status).toBe(302);
  expect(done.headers.get("location").startsWith(`${IDP_SLO}?`)).toBe(true);
  const answer = await new Response(new Blob([Uint8Array.from(atob(params(done).get("SAMLResponse")), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  expect(answer).toContain("LogoutResponse");
  expect(answer).toMatch(/InResponseTo="_lo\d+"/);
  expect(answer).toContain("status:Success");
  expect(params(done).get("RelayState")).toBe("r1");
  expect(await alive(a)).toBe(false);
  expect(await alive(b)).toBe(true);
  // The same request again: taken once.
  expect((await call(`/sso/saml/${conn.id}/slo`, null, { method: "POST", form: { SAMLRequest: encode(one) } })).status).toBe(400);

  // No SessionIndex: every sign-in of that person through this connection.
  const all = signPosted(logoutRequest({ sp: conn.sp }));
  expect((await call(`/sso/saml/${conn.id}/slo`, null, { method: "POST", form: { SAMLRequest: encode(all) } })).status).toBe(302);
  expect(await alive(b)).toBe(false);
  const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?1 AND action = 'sso.idp_signed_out'").bind(ORG).first();
  expect(logged.n).toBe(2);
});

test("single logout by redirect: the query's own signature is checked", async () => {
  const conn = await makeSaml({ metadataXml: metadata(IDP, IDP_SSO, idpCert), allowedDomains: ["acme.co.jp"] });
  expect(conn.idpSloUrl).toBe(null);
  await activate(conn.id);
  const a = await samlSession(conn, "_s9");
  const forged = await signedRedirect(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s9"] }), { key: "other" });
  expect((await call(`/sso/saml/${conn.id}/slo?${forged}`)).status).toBe(400);
  // A signed query with the request swapped out is refused too.
  const good = await signedRedirect(logoutRequest({ sp: conn.sp, sessionIndexes: ["_s9"] }));
  const other = await signedRedirect(logoutRequest({ sp: conn.sp, nameId: "boss@acme.co.jp" }));
  const swapped = `SAMLRequest=${new URLSearchParams(other).get("SAMLRequest") && other.split("&")[0].slice("SAMLRequest=".length)}&${good.split("&").slice(1).join("&")}`;
  expect((await call(`/sso/saml/${conn.id}/slo?${swapped}`)).status).toBe(400);
  expect(await alive(a)).toBe(true);
  // Without an IdP logout address, the answer is a page that says so.
  const res = await call(`/sso/saml/${conn.id}/slo?${good}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("signed out");
  expect(await alive(a)).toBe(false);
});


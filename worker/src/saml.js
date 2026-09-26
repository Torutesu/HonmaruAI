// SAML 2.0, the part of it single sign-on needs: an AuthnRequest sent by
// redirect, and the IdP's signed Response posted back to us.
//
// docs/sso-and-domain-join.md §11. The XML signature is checked by
// xml-crypto, never by hand, against the certificate the owner gave us —
// never one the response carries. Only what the signature covers is read
// (getSignedReferences), so an unsigned assertion slipped in beside a signed
// one ("signature wrapping") is never what we believe. Every condition the
// profile sets is checked: issuer, audience, recipient, the request it
// answers, and the time window. Documents with a DOCTYPE are refused
// outright, and encrypted assertions are not accepted.

import { SignedXml } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";

export const NS = {
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  md: "urn:oasis:names:tc:SAML:2.0:metadata",
};
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
/// SHA-1 is refused; so is HMAC, whose key would be the public certificate.
const ACCEPTED_SIGNATURES = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
]);
const SKEW_MS = 120_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const EMAIL_ATTRIBUTES = [
  "email", "mail", "emailaddress", "user.email",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const NAME_ATTRIBUTES = ["displayname", "name", "http://schemas.microsoft.com/identity/claims/displayname", "urn:oid:2.16.840.1.113730.3.1.241"];
const GIVEN_ATTRIBUTES = ["givenname", "firstname", "first_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname", "urn:oid:2.5.4.42"];
const SURNAME_ATTRIBUTES = ["surname", "lastname", "last_name", "sn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "urn:oid:2.5.4.4"];

const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const b64 = (bytes) => btoa(Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join(""));

// ---- Our side of the connection ----

export const spEntityId = (base, connectionId) => `${base}/sso/saml/${connectionId}`;
export const acsUrl = (base, connectionId) => `${base}/sso/saml/${connectionId}/acs`;

/// What an IdP is told about us: who we are and where to post.
export function spMetadata(entityId, acs) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${NS.md}" entityID="${escapeXml(entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="${NS.samlp}">
    <md:NameIDFormat>${EMAIL_FORMAT}</md:NameIDFormat>
    <md:AssertionConsumerService Binding="${POST_BINDING}" Location="${escapeXml(acs)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

/// The AuthnRequest, deflated and encoded for the HTTP-Redirect binding.
export async function redirectUrl({ ssoUrl, requestId, spEntity, acs, relayState, now = Date.now() }) {
  const xml = `<samlp:AuthnRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${escapeXml(requestId)}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${escapeXml(ssoUrl)}" AssertionConsumerServiceURL="${escapeXml(acs)}" ProtocolBinding="${POST_BINDING}"><saml:Issuer>${escapeXml(spEntity)}</saml:Issuer><samlp:NameIDPolicy Format="${EMAIL_FORMAT}" AllowCreate="true"/></samlp:AuthnRequest>`;
  const deflated = await new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  const url = new URL(ssoUrl);
  url.searchParams.set("SAMLRequest", b64(deflated));
  url.searchParams.set("RelayState", relayState);
  return url.toString();
}

// ---- Reading XML safely ----

function parse(xml) {
  const text = String(xml || "");
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new Error("The SAML document declares a DOCTYPE, which is not accepted.");
  let problem = null;
  const doc = new DOMParser({ onError: (level, msg) => { if (level !== "warning") problem = msg; } }).parseFromString(text, "text/xml");
  if (problem || !doc?.documentElement) throw new Error("The SAML document is not well-formed XML.");
  return doc;
}

const kids = (el, ns, local) => Array.from(el?.childNodes || []).filter((n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === local);
const kid = (el, ns, local) => kids(el, ns, local)[0] || null;
const textOf = (el) => (el?.textContent || "").trim();

/// A certificate as PEM, from PEM or bare base64.
export function normalizeCert(input) {
  const body = String(input || "").replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+=*$/.test(body) || body.length < 200) throw new Error("That is not an X.509 certificate.");
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
}

/// The IdP's metadata: its entity ID, where to send people (redirect
/// binding), and its signing certificate.
export function parseIdpMetadata(xml) {
  const doc = parse(xml);
  const root = doc.documentElement;
  const entity = root.localName === "EntityDescriptor" ? root : Array.from(root.getElementsByTagNameNS(NS.md, "EntityDescriptor"))[0];
  if (!entity) throw new Error("That is not SAML metadata (no EntityDescriptor).");
  const idp = kid(entity, NS.md, "IDPSSODescriptor");
  if (!idp) throw new Error("That metadata describes no identity provider.");
  const redirect = kids(idp, NS.md, "SingleSignOnService").find((s) => s.getAttribute("Binding") === REDIRECT_BINDING);
  if (!redirect) throw new Error("That identity provider has no HTTP-Redirect sign-in address.");
  const signing = kids(idp, NS.md, "KeyDescriptor").filter((k) => !k.getAttribute("use") || k.getAttribute("use") === "signing");
  const certNode = signing.map((k) => Array.from(k.getElementsByTagNameNS(NS.ds, "X509Certificate"))[0]).find(Boolean);
  if (!certNode) throw new Error("That metadata has no signing certificate.");
  return { entityId: entity.getAttribute("entityID"), ssoUrl: redirect.getAttribute("Location"), cert: normalizeCert(textOf(certNode)) };
}

function attributesOf(assertion) {
  const out = new Map();
  for (const statement of kids(assertion, NS.saml, "AttributeStatement")) {
    for (const attr of kids(statement, NS.saml, "Attribute")) {
      const values = kids(attr, NS.saml, "AttributeValue").map(textOf).filter(Boolean);
      for (const name of [attr.getAttribute("Name"), attr.getAttribute("FriendlyName")]) {
        if (name && values.length) out.set(name.toLowerCase(), values);
      }
    }
  }
  return out;
}
const firstOf = (attrs, names) => { for (const n of names) { const v = attrs.get(n.toLowerCase()); if (v?.length) return v[0]; } return null; };

function within(el, now, what) {
  const before = el?.getAttribute("NotBefore");
  const after = el?.getAttribute("NotOnOrAfter");
  if (before && Date.parse(before) - SKEW_MS > now) throw new Error(`The ${what} is not valid yet.`);
  if (after && Date.parse(after) + SKEW_MS <= now) throw new Error(`The ${what} has expired.`);
  if ((before && Number.isNaN(Date.parse(before))) || (after && Number.isNaN(Date.parse(after)))) throw new Error(`The ${what} has a time that cannot be read.`);
}

/// Check a posted SAMLResponse (base64) and return who it says signed in.
export function verifyResponse(encoded, { cert, idpEntityId, spEntity, acs, requestId, now = Date.now() }) {
  const raw = String(encoded || "").replace(/\s+/g, "");
  if (!raw || raw.length > MAX_RESPONSE_BYTES * 1.4) throw new Error("The SAML response is missing or too large.");
  let xml;
  try { xml = new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))); } catch { throw new Error("The SAML response is not base64."); }
  const doc = parse(xml);
  const response = doc.documentElement;
  if (response.namespaceURI !== NS.samlp || response.localName !== "Response") throw new Error("That is not a SAML Response.");

  const status = kid(kid(response, NS.samlp, "Status"), NS.samlp, "StatusCode")?.getAttribute("Value") || "";
  if (!status.endsWith(":Success")) {
    const message = textOf(kid(kid(response, NS.samlp, "Status"), NS.samlp, "StatusMessage"));
    throw new Error(`Your identity provider refused the sign-in${message ? `: ${message}` : ` (${status.split(":").pop() || "no status"})`}.`);
  }
  if (kids(response, NS.saml, "EncryptedAssertion").length) throw new Error("Encrypted assertions are not supported. Turn off assertion encryption for this app in your identity provider.");
  const assertions = kids(response, NS.saml, "Assertion");
  if (assertions.length !== 1) throw new Error("The SAML response must carry exactly one assertion.");

  // The signature: on the assertion, or else on the whole response.
  const holder = kid(assertions[0], NS.ds, "Signature") ? assertions[0] : kid(response, NS.ds, "Signature") ? response : null;
  if (!holder) throw new Error("The SAML response is not signed.");
  const sig = new SignedXml({ publicCert: cert, getCertFromKeyInfo: () => null });
  sig.loadSignature(kid(holder, NS.ds, "Signature"));
  if (!ACCEPTED_SIGNATURES.has(sig.signatureAlgorithm)) throw new Error("The SAML response is signed with an algorithm that is not accepted (use RSA-SHA256).");
  let valid = false;
  try { valid = sig.checkSignature(xml); } catch { valid = false; }
  if (!valid) throw new Error("The SAML response's signature is not valid.");
  const signed = sig.getSignedReferences();
  if (signed.length !== 1) throw new Error("The SAML signature must cover exactly one element.");
  // From here on, only the signed copy is read — and it must be the very
  // element that holds the signature.
  const signedRoot = parse(signed[0]).documentElement;
  if (!holder.getAttribute("ID") || signedRoot.getAttribute("ID") !== holder.getAttribute("ID")) throw new Error("The SAML signature does not cover the element it sits in.");
  const assertion = signedRoot.namespaceURI === NS.saml && signedRoot.localName === "Assertion" ? signedRoot
    : signedRoot.namespaceURI === NS.samlp && signedRoot.localName === "Response" && kids(signedRoot, NS.saml, "Assertion").length === 1 ? kid(signedRoot, NS.saml, "Assertion")
      : null;
  if (!assertion) throw new Error("The SAML signature does not cover an assertion.");
  if (assertion.getAttribute("ID") !== assertions[0].getAttribute("ID")) throw new Error("The signed assertion is not the one in the response.");

  if (textOf(kid(assertion, NS.saml, "Issuer")) !== idpEntityId) throw new Error("The assertion is from a different identity provider.");
  const conditions = kid(assertion, NS.saml, "Conditions");
  within(conditions, now, "assertion");
  const audiences = kids(conditions, NS.saml, "AudienceRestriction").flatMap((r) => kids(r, NS.saml, "Audience").map(textOf));
  if (!audiences.includes(spEntity)) throw new Error("The assertion is for a different application.");

  const subject = kid(assertion, NS.saml, "Subject");
  const nameId = kid(subject, NS.saml, "NameID");
  const bearer = kids(subject, NS.saml, "SubjectConfirmation").find((c) => c.getAttribute("Method") === "urn:oasis:names:tc:SAML:2.0:cm:bearer");
  const data = kid(bearer, NS.saml, "SubjectConfirmationData");
  if (!data) throw new Error("The assertion has no bearer confirmation.");
  if (data.getAttribute("Recipient") !== acs) throw new Error("The assertion was sent to a different address.");
  if (data.getAttribute("InResponseTo") !== requestId) throw new Error("The assertion does not answer this sign-in.");
  if (!data.getAttribute("NotOnOrAfter")) throw new Error("The assertion's confirmation has no expiry.");
  within(data, now, "confirmation");
  // The envelope, where it says, must agree (it may be unsigned: checked, never trusted).
  const inResponseTo = response.getAttribute("InResponseTo");
  if (inResponseTo && inResponseTo !== requestId) throw new Error("The SAML response does not answer this sign-in.");
  const destination = response.getAttribute("Destination");
  if (destination && destination !== acs) throw new Error("The SAML response was sent to a different address.");

  const attrs = attributesOf(assertion);
  const nameIdText = textOf(nameId);
  const email = (firstOf(attrs, EMAIL_ATTRIBUTES) || (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nameIdText) ? nameIdText : "")).trim().toLowerCase();
  const given = firstOf(attrs, GIVEN_ATTRIBUTES);
  const surname = firstOf(attrs, SURNAME_ATTRIBUTES);
  const name = firstOf(attrs, NAME_ATTRIBUTES) || [given, surname].filter(Boolean).join(" ") || null;
  if (!nameIdText) throw new Error("The assertion does not say who this is.");
  if (!email) throw new Error("The assertion carries no email address.");
  return { subject: nameIdText, email, name, assertionId: assertion.getAttribute("ID") };
}

#!/usr/bin/env node
// Print a fresh VAPID key pair, in the format the Worker reads.
//
//   node scripts/vapid-keys.mjs
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY
//   npx wrangler secret put VAPID_SUBJECT      # mailto:you@example.com
//
// The public key is a raw uncompressed P-256 point (65 bytes), the private key
// the 32-byte scalar, both base64url — the same shapes `web-push` prints, so a
// pair generated with that tool works here unchanged.

import { webcrypto } from "node:crypto";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));

console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");

# Public file snapshot links

Harness public file sharing publishes an immutable workspace file version and up to ten immutable asset versions. The manifest points at the existing R2 object keys; creating a link does not copy the file or add storage charges. A live, unexpired share blocks purging any version it references.

Human-created links are immediately active and support `24h`, `7d`, `30d`, or `never` expiry, download permission, and reusable links. Updating a reusable link publishes the current file and selected assets as a new revision while keeping the same URL. Agent-created or Agent-updated links remain unpublished until the owner approves the exact snapshot, expiry, and download policy. If the source turn, membership, write permission, file version, or asset version changes before approval, the request becomes stale and no new revision is published. Existing revision settings are retained on an Agent update.

The public token is derived from a random 256-bit share id and an HMAC using `DATA_KEY`, with the `honmaru:file-share:v1` domain separator and the workspace id in the authenticated message. Only the id, HMAC, and link metadata are persisted; listing shares never returns the token. Changing or rotating `DATA_KEY` invalidates all existing file-share URLs. Restoring those links requires restoring the prior key; this implementation does not keep old signing keys.

Public reads return `no-store`, `no-referrer`, `noindex`, and `nosniff` headers. The download choice controls `Content-Disposition`; display-only links are limited to a small safe inline media/text allowlist. Public content streams from R2 and is capped at 25 MiB. Text previews are capped at 128 KiB. Revocation prevents future reads through Honmaru; it cannot recall bytes a viewer already downloaded or copied elsewhere.

Simple mode does not expose public share controls or routes. The separate Kylon `file public-url` capability (permanent per-version media URLs with file-wide revoke and up to one-day shared caching) is not part of this snapshot-share implementation and remains a tracked gap.

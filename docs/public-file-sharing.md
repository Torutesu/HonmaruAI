# Public file snapshot links

Harness public file sharing publishes an immutable workspace file version and up to ten immutable asset versions. The manifest points at the existing R2 object keys; creating a link does not copy the file or add storage charges. A live, unexpired share blocks purging any version it references.

Human-created links are immediately active and support `24h`, `7d`, `30d`, or `never` expiry, download permission, and reusable links. Updating a reusable link publishes the current file and selected assets as a new revision while keeping the same URL. Agent-created or Agent-updated links remain unpublished until the owner approves the exact snapshot, expiry, and download policy. If the source turn, membership, write permission, file version, or asset version changes before approval, the request becomes stale and no new revision is published. Existing revision settings are retained on an Agent update.

The public token is derived from a random 256-bit share id and an HMAC using `DATA_KEY`, with the `honmaru:file-share:v1` domain separator and the workspace id in the authenticated message. Only the id, HMAC, and link metadata are persisted; listing shares never returns the token. Changing or rotating `DATA_KEY` invalidates all existing file-share URLs. Restoring those links requires restoring the prior key; this implementation does not keep old signing keys.

Public reads return `no-store`, `no-referrer`, `noindex`, and `nosniff` headers. The download choice controls `Content-Disposition`; display-only links are limited to a small safe inline media/text allowlist. Public content streams from R2 and is capped at 25 MiB. Text previews are capped at 128 KiB. Revocation prevents future reads through Honmaru; it cannot recall bytes a viewer already downloaded or copied elsewhere.

## Permanent media URLs

Harness also provides a separate direct-media URL for the current image, video, audio, or font version. `POST /hx/files/:id/public-url` creates a link or returns the same link for that version; publishing a later version creates a new link while earlier version links remain live. `DELETE /hx/files/:id/public-url` revokes every version link for that file. Version purge and file deletion invalidate the affected links as part of their D1 write. File history and URL metadata use the existing D1/R2 storage; no media copy or new provider is used.

The public URL is a 256-bit random id plus an HMAC using `DATA_KEY`. D1 stores its SHA-256 token hash and the version metadata, not the bearer token. `FILE_SIGNING_KEY` rotation does not affect these links. Deployments keep `DATA_KEY` stable; manually replacing it invalidates the links, and the old key is not retained. The worker fails closed when the key is missing or invalid.

Successful media responses use `public, max-age=86400, s-maxage=86400, immutable` and a one-day `CDN-Cache-Control`, matching Kylon's maximum shared-cache window. After revoke, purge, or deletion, origin reads stop immediately, but a shared cache may serve a previously cached response for up to 24 hours; Honmaru cannot recall bytes that were already downloaded. R2 misses and revoked links return a no-store 404. Public responses are limited to the media MIME allowlist, capped at 25 MiB, and served inline with `nosniff`, a sandbox CSP, and cross-origin media headers.

Public media URLs do not use the snapshot-share approval flow. Direct creation is available to authorized file writers in Harness mode; revoking all versions requires file-manager authority. Switching to Simple mode hides Harness controls and management routes, while an already issued direct URL stays live until it is revoked, its file/version is deleted or purged, or its cache window ends.

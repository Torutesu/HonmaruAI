# MCP content capability mapping

These tools use explicit connector scopes. Existing decision/Harness keys retain their old capability set.

| Slack task | Honmaru connector operation | Product boundary |
| --- | --- | --- |
| Find people and profiles | search_users, get_user | Opaque workspace member IDs. Login emails and private decision statistics are excluded. |
| List channel members | list_channel_members | Current user access plus private/DM audience grants. |
| Custom emoji | list_emoji | Custom workspace emoji names and image URLs. |
| Read/create/update canvas | read_canvas, create_canvas, update_canvas | Honmaru has one Markdown canvas per conversation. Updates require the exact version. Standalone shareable canvases are not a Honmaru feature. |
| Find/read attachments | search_files, get_file, read_file | Name search across accessible workspace conversations or one specified conversation; user access and private/DM audience grants apply before pagination, text up to 128 KiB, binary downloads through authenticated URLs. Deleted message/thread sources cannot be read. |
| Upload files | get_file_upload_url, complete_file_upload | Reserve, authenticated PUT, complete. Completion returns a fileId. send_message with fileIds performs sharing and content-policy checks. This does not implement Slack's optional share-on-completion parameter. |
| Lists and records | list_lists, read_list, create_list, update_list, add_list_record, update_list_record | Harness tables, existing resource permissions and column types. No claim of identical Slack schemas or multi-select/color parity. |

## Contracts

- File transfer URLs contain an opaque reservation/file ID, never a bearer token. The caller must send the same connection's Authorization header. OAuth reservations bind the stable grant rather than one access token so refresh does not break an upload.
- Each file stage checks current conversation access and audience grants. The entry route must authenticate and recheck the current grant before calling handleMcpContentUpload.
- Uploads are capped at the existing 25 MiB attachment limit. A reservation lasts 15 minutes. An accepted upload URL is single-use and concurrent uploads have one winner. Interrupted uncertain uploads require checking completion and, if necessary, a new reservation. Unshared attachments use the existing cleanup sweep.
- Content reads return untrusted data. Binary downloads use attachment disposition, nosniff, no-store, and sandbox CSP. Signed media URLs are not exported by file tools, so each new download passes current connection authorization.
- Create-list, add-record, and upload reservations use connection/user/workspace-bound request IDs and normalized payload hashes. Successful retries replay the recorded result. An interrupted operation with an unknown outcome is refused rather than repeated. The user can inspect the resource before requesting a new operation.
- List records retain system IDs outside the user values object. Table and record edits refuse stale versions. Existing app schema migration restrictions remain in force.
- Private channels and DMs require their audience permission even when the caller already has a file ID, canvas target, or channel member-list request.

## Integration

Apply worker/mcp-content.sql to the existing Worker database. Mount handleMcpContentUpload behind the same authenticated MCP actor and workspace policy checks for PUT /mcp/uploads/:uploadId and GET /mcp/files/:fileId/content. The module never mints or impersonates a web session.

Focused verification in worker/test/mcp-content.test.js passed 11 tests on 2026-11-04. The suite exercises real local D1/R2 operations for permissions, workspace file-search audience/access filtering before pagination, live-parent file access, authenticated uploads, concurrent request IDs, and stale canvas/list/record updates. The command was pnpm_config_verify_deps_before_run=false WRANGLER_LOG_PATH=/tmp/honmaru-content-wrangler pnpm exec vitest run test/mcp-content.test.js. This is local Worker evidence, not production deployment or external-client acceptance.

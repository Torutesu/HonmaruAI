// A changed reply draft is delivered only to the same Agent, with the
// member's next direct message. Keep only the changed span, and expire it
// quickly; never send a draft or trigger an external reply from this module.
export const MAX_DRAFT_EDIT_DELTA = 2000;
export const DRAFT_EDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function draftEditDelta(original, revised) {
  if (typeof original !== 'string' || typeof revised !== 'string') return null;
  let start = 0;
  while (start < original.length && start < revised.length && original[start] === revised[start]) start++;
  let oldEnd = original.length;
  let newEnd = revised.length;
  while (oldEnd > start && newEnd > start && original[oldEnd - 1] === revised[newEnd - 1]) { oldEnd--; newEnd--; }
  const removed = original.slice(start, oldEnd);
  const added = revised.slice(start, newEnd);
  if (!removed && !added) return null;
  if (removed.length + added.length > MAX_DRAFT_EDIT_DELTA) return { tooLarge: true };
  return { removed, added };
}

export async function queueDraftEdit(db, { orgId, githubId, agentId, cardId, delta, now = Date.now() }) {
  if (!delta || delta.tooLarge || (!delta.removed && !delta.added)) return { queued: false };
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + DRAFT_EDIT_TTL_MS).toISOString();
  const row = await db.prepare(`INSERT INTO hx_agent_draft_edit_pending
    (org_id,user_github_id,agent_id,card_id,removed_text,added_text,created_at,expires_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8
    WHERE EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2)
      AND EXISTS(SELECT 1 FROM custom_agents WHERE org_id=?1 AND id=?3 AND deleted_at IS NULL)
    ON CONFLICT(org_id,user_github_id,agent_id,card_id) DO UPDATE SET
      removed_text=excluded.removed_text,added_text=excluded.added_text,created_at=excluded.created_at,expires_at=excluded.expires_at
    RETURNING card_id`).bind(orgId,String(githubId),agentId,cardId,delta.removed,delta.added,createdAt,expiresAt).first();
  return { queued: Boolean(row), cardId, expiresAt };
}

export async function discardDraftEdit(db, { orgId, githubId, cardId }) {
  const result = await db.prepare(`DELETE FROM hx_agent_draft_edit_pending
    WHERE org_id=?1 AND user_github_id=?2 AND card_id=?3`).bind(orgId,String(githubId),cardId).run();
  return result?.meta?.changes || 0;
}

/// Bind queued edits atomically to this exact next message. A racing send can
/// win once only; replayed message IDs cannot consume or duplicate feedback.
export async function attachDraftEditsToMessage(db, { orgId, githubId, agentId, messageId, now = Date.now() }) {
  const at = new Date(now).toISOString();
  const cutoff = at;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_agent_draft_edit_context
      (org_id,message_id,user_github_id,agent_id,card_id,removed_text,added_text,created_at,expires_at)
      SELECT org_id,?5,user_github_id,agent_id,card_id,removed_text,added_text,?6,?7
      FROM hx_agent_draft_edit_pending WHERE org_id=?1 AND user_github_id=?2 AND agent_id=?3
        AND expires_at>?4`).bind(orgId,String(githubId),agentId,cutoff,messageId,at,new Date(now + DRAFT_EDIT_TTL_MS).toISOString()),
    db.prepare(`DELETE FROM hx_agent_draft_edit_pending WHERE org_id=?1 AND user_github_id=?2
      AND agent_id=?3 AND expires_at<=?4`).bind(orgId,String(githubId),agentId,cutoff),
    db.prepare(`DELETE FROM hx_agent_draft_edit_pending WHERE org_id=?1 AND user_github_id=?2 AND agent_id=?3 AND expires_at>?4`)
      .bind(orgId,String(githubId),agentId,cutoff),
  ]);
  return listDraftEditContext(db,{orgId,messageId,agentId});
}

export async function listDraftEditContext(db, { orgId, messageId, agentId }) {
  const { results = [] } = await db.prepare(`SELECT card_id,removed_text,added_text FROM hx_agent_draft_edit_context
    WHERE org_id=?1 AND message_id=?2 AND agent_id=?3 AND expires_at>?4 ORDER BY created_at LIMIT 8`).bind(orgId,messageId,agentId,new Date().toISOString()).all();
  return results;
}

export async function consumeDraftEditContext(db, { orgId, messageId, agentId }) {
  const edits = await listDraftEditContext(db,{orgId,messageId,agentId});
  if (edits.length) await db.prepare(`DELETE FROM hx_agent_draft_edit_context WHERE org_id=?1 AND message_id=?2 AND agent_id=?3`)
    .bind(orgId,messageId,agentId).run();
  return edits;
}

export function draftEditPrompt(edits) {
  if (!edits?.length) return '';
  const changes = edits.slice(0,8).map((edit) => [
    edit.removed_text ? `Removed: ${edit.removed_text}` : '',
    edit.added_text ? `Added: ${edit.added_text}` : '',
  ].filter(Boolean).join('\n')).join('\n---\n').slice(0, 8000);
  return `\n\nPrivate context from the user's recent reply-draft edits (one-time; do not quote these snippets to other people, and do not send any email/post):\n${changes}\nTreat the changes as guidance for this conversation. If they suggest a reusable writing preference, ask the user whether they want you to remember it. Save it only after their explicit confirmation using your available personal memory controls.`;
}

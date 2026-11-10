import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { upsertMembership, upsertUser } from '../src/db.js';
import { isGuest, isGuestLogin } from '../src/access.js';
import { mayUseConversation } from '../src/harness/conversationAccess.js';
import { resolveChannel } from '../src/channels.js';

test('mixed-case or padded guest roles stay guest-only at public and private room boundaries', async () => {
  const org = 'room-role-normalization';
  const guestId = 'mixed-role-guest';
  const guestLogin = 'mixed-role-guest';
  const at = new Date().toISOString();
  await upsertUser(env.DB, { githubId: guestId, login: guestLogin, name: 'Guest' });
  await upsertUser(env.DB, { githubId: 'room-member', login: 'room-member', name: 'Member' });
  await upsertMembership(env.DB, org, guestId, 'member');
  await upsertMembership(env.DB, org, 'room-member', 'member');
  // Simulate legacy/imported data that reaches a security boundary before a
  // schema normalization pass. All supported writes still store lowercase roles.
  await env.DB.prepare("UPDATE memberships SET role=' Guest ' WHERE org_id=?1 AND user_github_id=?2")
    .bind(org, guestId).run();
  await env.DB.prepare(`INSERT INTO businesses(org_id,slug,name,created_at,private) VALUES
    (?1,'role-public','Public room',?2,0), (?1,'role-private','Private room',?2,1)`)
    .bind(org, at).run();
  await env.DB.prepare(`INSERT INTO conversation_members(org_id,channel,login,added_by,added_at)
    VALUES(?1,'b:role-private',?2,?2,?3)`)
    .bind(org, guestLogin, at).run();

  expect(await isGuest(env.DB, org, guestId)).toBe(true);
  expect(await isGuestLogin(env.DB, org, guestLogin)).toBe(true);

  // A guest who is not named on a public room cannot gain workspace-wide
  // visibility just because the role has unusual casing or whitespace.
  expect(await resolveChannel(env.DB, org, { github_id: guestId, login: guestLogin }, 'b:role-public')).toBeNull();
  // Harness-scoped room data requires an active non-guest workspace member,
  // even if a stale room-membership row survives a role import/demotion.
  expect(await mayUseConversation(env.DB, org, guestId, 'b:role-private')).toBe(false);
});

// People, as a chat client knows them: a status, "away until", somebody to
// decide in your place meanwhile, how loud each conversation may be, and a
// profile with the numbers that matter in a decision feed.

const LEVELS = new Set(["all", "mentions", "mute"]);

export async function setStatus(db, { orgId, githubId, emoji, text, until, awayUntil, delegateLogin }) {
  const clean = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const time = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) && t > Date.now() && t < Date.now() + 366 * 86400000 ? new Date(t).toISOString() : undefined;
  };
  const statusUntil = time(until);
  const away = time(awayUntil);
  if (statusUntil === undefined || away === undefined) return { error: "Pick a time within the next year." };
  await db.prepare(
    `UPDATE memberships SET status_emoji = ?3, status_text = ?4, status_until = ?5, away_until = ?6, delegate_login = ?7
      WHERE org_id = ?1 AND user_github_id = ?2`
  ).bind(orgId, String(githubId), clean(emoji, 16), clean(text, 100), statusUntil, away, away ? (delegateLogin || null) : null).run();
  return { ok: true };
}

export async function rememberTimezone(db, githubId, tz) {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 64) return;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return; }
  await db.prepare("UPDATE users SET timezone = ?2 WHERE github_id = ?1 AND (timezone IS NULL OR timezone != ?2)").bind(String(githubId), tz).run();
}

/// A new card for somebody who is away goes to whoever they named — once,
/// never along a chain — and says so.
export async function redirectIfAway(members, card) {
  const to = members.find((m) => m.login === card.recipientUserID);
  if (!to?.awayUntil || !to.delegateLogin || to.delegateLogin === to.login) return null;
  const delegate = members.find((m) => m.login === to.delegateLogin);
  if (!delegate || delegate.login === card.senderUserID) return null;
  card.recipientUserID = delegate.login;
  card.recipientName = delegate.name;
  card.recipientMemberRef = delegate.ref;
  card.coveringFor = { name: to.name, until: to.awayUntil };
  card.routingReason = `${to.name} is away until ${to.awayUntil.slice(0, 10)}; ${delegate.name} decides meanwhile.${card.routingReason ? ` ${card.routingReason}` : ""}`;
  return { from: to, to: delegate };
}

export async function setChannelPref(db, { orgId, login, key, level }) {
  if (!LEVELS.has(level)) return { error: "Level is all, mentions or mute." };
  if (level === "all") {
    await db.prepare("DELETE FROM channel_prefs WHERE org_id = ?1 AND login = ?2 AND channel = ?3").bind(orgId, login, key).run();
  } else {
    await db.prepare(
      `INSERT INTO channel_prefs (org_id, login, channel, level) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (org_id, login, channel) DO UPDATE SET level = excluded.level`
    ).bind(orgId, login, key, level).run();
  }
  return { ok: true };
}

export async function prefsFor(db, orgId, login) {
  const { results } = await db.prepare("SELECT channel, level FROM channel_prefs WHERE org_id = ?1 AND login = ?2").bind(orgId, login).all();
  return results || [];
}

/// A teammate's page: who, how to reach them, and how they are with decisions.
export async function memberProfile(db, orgId, member) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const [waiting, decided, times] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND status = 'pending'").bind(orgId, member.login).first(),
    db.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND status != 'pending' AND decided_at >= ?3").bind(orgId, member.login, since).first(),
    db.prepare(
      `SELECT created_at, decided_at FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND decided_at IS NOT NULL AND decided_at >= ?3
        ORDER BY decided_at DESC LIMIT 200`
    ).bind(orgId, member.login, since).all(),
  ]);
  const waits = (times.results || [])
    .map((r) => Date.parse(r.decided_at) - Date.parse(r.created_at))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  return {
    ref: member.ref,
    name: member.name,
    handle: member.handle || null,
    title: member.title || member.role,
    role: member.role,
    timezone: member.timezone || null,
    status: member.status || null,
    awayUntil: member.awayUntil || null,
    joinedAt: member.joinedAt,
    stats: { waiting: waiting?.n || 0, decided90d: decided?.n || 0, medianMinutes: median === null ? null : Math.round(median / 60000) },
  };
}

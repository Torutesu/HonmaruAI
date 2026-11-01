// The token parameter is the server-side session key, never the bearer token.
// A null key is used only by internal non-HTTP callers.
// D1 stores app-generated timestamps as ISO milliseconds. Round the Julian
// day difference to integer milliseconds before applying brokenRule's strict
// `>` boundary, avoiding floating-point noise at an exact hour.
const elapsedMs = expression => `COALESCE(ROUND((julianday('now')-julianday(${expression}))*86400000),0)`;
export const skillSessionAuthority = (org, user, token) => `NOT EXISTS(SELECT 1 FROM scim_users sc
  WHERE sc.org_id=${org} AND sc.user_github_id=${user} AND sc.active=0)
  AND (${token} IS NULL OR (EXISTS(SELECT 1 FROM sessions sess WHERE sess.token=${token} AND sess.github_id=${user}
    AND (sess.expires_at IS NULL OR sess.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND NOT EXISTS(SELECT 1 FROM org_session_policy p WHERE p.org_id=${org} AND (
      (COALESCE(CASE WHEN LOWER(COALESCE(sess.client,''))='ios' THEN p.mobile_max_hours ELSE p.web_max_hours END,0)!=0
       AND ${elapsedMs('sess.created_at')} > (CASE WHEN LOWER(COALESCE(sess.client,''))='ios' THEN p.mobile_max_hours ELSE p.web_max_hours END)*3600000)
      OR (COALESCE(p.idle_hours,0)!=0 AND (COALESCE(sess.longest_idle_ms,0)>p.idle_hours*3600000
       OR ${elapsedMs("COALESCE(NULLIF(sess.last_seen_at,''),NULLIF(sess.created_at,''))")} > p.idle_hours*3600000)))))
    AND NOT EXISTS(SELECT 1 FROM session_workspaces sw WHERE sw.token=${token} AND sw.org_id=${org} AND sw.ended_at IS NOT NULL)))`;

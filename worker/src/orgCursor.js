// Jobs that visit every workspace, a page at a time.
//
// The daily and weekly sweeps used to read `... LIMIT 50` with no order and
// no memory of where they stopped: the same fifty workspaces every run, and
// the fifty-first never pruned or checked at all. Now each job walks the
// workspaces in org_id order, and when one run has done its share it leaves
// a cursor in `kv` for the next run to pick up from. A run that reaches the
// end clears it, so the next one starts again from the first.

const PAGE = 50;

/// The workspaces for this run of `job`, in order. `page(after, limit)` returns
/// a prepared statement selecting `org_id` for workspaces with org_id > after,
/// ordered by org_id, at most `limit` rows. `perRun` bounds one run's work.
export async function orgsInTurn(db, job, page, { perRun = 500 } = {}) {
  const key = `cursor:${job}`;
  const kept = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(key).first().catch(() => null);
  let after = kept?.value || "";
  const orgs = [];
  let finished = false;
  while (orgs.length < perRun) {
    const limit = Math.min(PAGE, perRun - orgs.length);
    const { results } = await page(after, limit).all();
    const rows = results || [];
    orgs.push(...rows);
    if (rows.length) after = rows[rows.length - 1].org_id;
    // A short page is the last one.
    if (rows.length < limit) { finished = true; break; }
  }
  // The end reached: the next run starts at the beginning again.
  const next = finished ? "" : after;
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, next, new Date().toISOString()).run().catch(() => {});
  return orgs;
}

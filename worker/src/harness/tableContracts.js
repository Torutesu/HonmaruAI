const MAX_VERSIONS = 100;
const HASH = /^[a-f0-9]{64}$/;

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashTableContract(contract) {
  return hashText(JSON.stringify(contract));
}

export async function publishTableContract(db, { orgId, table, contract, by }) {
  if (!table || !table.updatedAt) return { error: 'Reload the table before publishing its contract.', status: 409 };
  const contractJson = JSON.stringify(contract);
  const contractHash = await hashText(contractJson);
  const existing = await db.prepare(`SELECT contract_json AS contractJson FROM hx_table_contract_versions
    WHERE org_id=?1 AND table_id=?2 AND contract_hash=?3`).bind(orgId, table.id, contractHash).first();
  if (existing) {
    if (existing.contractJson !== contractJson) return { error: 'Contract hash collision.', status: 500 };
    return { contractVersion: contractHash, created: false };
  }
  const at = new Date().toISOString();
  const inserted = await db.prepare(`INSERT INTO hx_table_contract_versions
      (org_id,table_id,contract_hash,contract_json,created_by,created_at)
    SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(
      SELECT 1 FROM hx_tables WHERE org_id=?1 AND id=?2 AND updated_at=?7
    ) AND (SELECT COUNT(*) FROM hx_table_contract_versions WHERE org_id=?1 AND table_id=?2)<?8`)
    .bind(orgId, table.id, contractHash, contractJson, String(by), at, table.updatedAt, MAX_VERSIONS).run();
  if (!inserted.meta?.changes) {
    const count = await db.prepare('SELECT COUNT(*) AS count FROM hx_table_contract_versions WHERE org_id=?1 AND table_id=?2').bind(orgId, table.id).first();
    if (Number(count?.count || 0) >= MAX_VERSIONS) return { error: `This table already has ${MAX_VERSIONS} immutable contract versions.`, status: 409 };
    return { error: 'The table schema changed. Reload it before publishing a contract.', status: 409 };
  }
  return { contractVersion: contractHash, created: true };
}

export async function listTableContracts(db, orgId, tableId) {
  const { results = [] } = await db.prepare(`SELECT v.contract_hash AS contractVersion,
      CASE WHEN m.user_github_id IS NOT NULL THEN COALESCE(NULLIF(TRIM(u.name),''),u.login) ELSE NULL END AS createdBy,
      v.created_at AS createdAt
    FROM hx_table_contract_versions v
    LEFT JOIN users u ON u.github_id=v.created_by
    LEFT JOIN memberships m ON m.org_id=v.org_id AND m.user_github_id=v.created_by
    WHERE v.org_id=?1 AND v.table_id=?2
    ORDER BY v.created_at DESC,v.contract_hash DESC LIMIT ?3`).bind(orgId, tableId, MAX_VERSIONS).all();
  return { versions: results };
}

export async function readTableContract(db, orgId, tableId, version) {
  if (typeof version !== 'string' || !HASH.test(version)) return { error: 'Choose a valid contract version.', status: 400 };
  const row = await db.prepare(`SELECT v.contract_hash AS contractVersion,v.contract_json AS contractJson,
      CASE WHEN m.user_github_id IS NOT NULL THEN COALESCE(NULLIF(TRIM(u.name),''),u.login) ELSE NULL END AS createdBy,
      v.created_at AS createdAt
    FROM hx_table_contract_versions v
    LEFT JOIN users u ON u.github_id=v.created_by
    LEFT JOIN memberships m ON m.org_id=v.org_id AND m.user_github_id=v.created_by
    WHERE v.org_id=?1 AND v.table_id=?2 AND v.contract_hash=?3`).bind(orgId, tableId, version).first();
  if (!row) return { error: 'No such table contract version.', status: 404 };
  if (await hashText(row.contractJson) !== row.contractVersion) return { error: 'This table contract failed its integrity check.', status: 503 };
  let contract;
  try { contract = JSON.parse(row.contractJson); }
  catch { return { error: 'This table contract failed its integrity check.', status: 503 }; }
  return { contractVersion: row.contractVersion, createdBy: row.createdBy, createdAt: row.createdAt, contract };
}

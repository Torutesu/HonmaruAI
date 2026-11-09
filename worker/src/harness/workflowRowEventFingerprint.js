function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Preserve the established row-trigger receipt hash across delivery paths and
// deploys so an outbox redelivery joins the same per-workflow dedupe receipt.
export async function rowEventFingerprint(table, before, row) {
  const payload = {
    tableId: table.id,
    rowId: (row || before).id,
    before: before ? { updatedAt: before.updatedAt || null, values: before.values || {} } : null,
    after: row ? { updatedAt: row.updatedAt || null, values: row.values || {} } : null,
    ...(!row ? { event: "deleted" } : {}),
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

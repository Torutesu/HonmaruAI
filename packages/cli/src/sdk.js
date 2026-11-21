function safeType(column) {
  switch (column?.type) {
    case "number": return "number | null";
    case "checkbox": return "boolean | null";
    case "relation": return column.multiple ? "string[] | null" : "string | null";
    case "text": case "date": case "datetime": case "select": case "url": case "email": case "person":
      return "string | null";
    default: return "unknown";
  }
}

function quote(value) {
  return JSON.stringify(String(value));
}

export function generateTableSdk(table, { contractVersion } = {}) {
  if (!table || typeof table.id !== "string" || !Array.isArray(table.columns)) {
    throw new Error("The table response has no usable schema.");
  }
  if (contractVersion !== undefined && !/^[a-f0-9]{64}$/.test(contractVersion)) throw new Error("The table contract version is invalid.");
  const columns = table.columns.filter((column) => column && typeof column.id === "string");
  if (!columns.length) throw new Error("The table has no columns to generate types from.");
  const fields = columns.map((column) => `  ${quote(column.id)}: ${safeType(column)};`).join("\n");
  const name = String(table.name || "Honmaru table").replace(/[\r\n]/g, " ");
  return `// Generated from ${contractVersion ? `immutable Honmaru contract ${contractVersion}` : "the current Honmaru table schema"}. Regenerate after schema changes.\n// Table: ${name}\nexport const CONTRACT_VERSION = ${contractVersion ? quote(contractVersion) : "null"} as const;\nexport type RowValues = {\n${fields}\n};\n\nexport type HonmaruRow = { id: string; tableId: string; values: Partial<RowValues>; position: number; createdBy: string | null; updatedBy: string | null; createdAt: string; updatedAt: string };\nexport type RowPage = { table: { id: string; orgId: string; name: string; columns: Array<{ id: string; name: string; type: string }> }; rows: HonmaruRow[]; total: number; offset: number; limit: number; nextOffset: number | null };\nexport type HonmaruClientOptions = { apiUrl: string; orgId: string; sessionToken: string; fetcher?: typeof fetch };\nconst TABLE_ID = ${quote(table.id)};\n\n/** Dependency-free typed client for the strict table REST contract. */\nexport function createHonmaruClient({ apiUrl, orgId, sessionToken, fetcher = fetch }: HonmaruClientOptions) {\n  const endpoint = new URL("/tables/" + encodeURIComponent(TABLE_ID), apiUrl);\n  async function request<T>(url: URL, method: string, body?: unknown): Promise<T> {\n    const response = await fetcher(url, { method, redirect: "error", headers: { accept: "application/json", "x-session-token": sessionToken, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });\n    if (!response.ok) {\n      const payload = await response.json().catch(() => null) as { message?: string } | null;\n      throw new Error("Honmaru API returned HTTP " + response.status + (payload?.message ? ": " + payload.message : "."));\n    }\n    return response.json() as Promise<T>;\n  }\n  return {\n    listRows(options: { q?: string; where?: Partial<RowValues>; sort?: string; limit?: number; offset?: number } = {}) {\n      const url = new URL(endpoint); url.searchParams.set("orgId", orgId);\n      for (const key of ["q", "sort", "limit", "offset"] as const) if (options[key] !== undefined) url.searchParams.set(key, String(options[key]));\n      if (options.where !== undefined) url.searchParams.set("where", JSON.stringify(options.where));\n      return request<RowPage>(url, "GET");\n    },\n    createRow(values: Partial<RowValues>) {\n      const url = new URL(endpoint + "/rows");\n      return request<{ row: HonmaruRow }>(url, "POST", { orgId, validation: "strict", values });\n    },\n    updateRow(rowId: string, values: Partial<RowValues>, expectedUpdatedAt: string) {\n      const url = new URL(endpoint + "/rows/" + encodeURIComponent(rowId));\n      return request<{ row: HonmaruRow }>(url, "PATCH", { orgId, validation: "strict", values, expectedUpdatedAt });\n    },\n    deleteRow(rowId: string, expectedUpdatedAt: string) {\n      const url = new URL(endpoint + "/rows/" + encodeURIComponent(rowId));\n      url.searchParams.set("orgId", orgId); url.searchParams.set("expectedUpdatedAt", expectedUpdatedAt);\n      return request<{ deleted: true; before: HonmaruRow }>(url, "DELETE");\n    },\n  };\n}\n`;
}

export function generateTableSdkFromContract(contract, contractVersion) {
  if (!contract || typeof contract !== "object" || contract.openapi !== "3.1.0") throw new Error("The pinned table contract is invalid.");
  const table = contract["x-honmaru-table"];
  if (!table || typeof table.id !== "string" || !Array.isArray(table.columns)) throw new Error("The pinned contract has no Honmaru table schema.");
  const paths = contract.paths;
  const tablePath = `/tables/${table.id}`;
  if (!paths?.[tablePath]?.get || !paths?.[`${tablePath}/rows`]?.post || !paths?.[`${tablePath}/rows/{rowId}`]?.patch || !paths?.[`${tablePath}/rows/{rowId}`]?.delete) {
    throw new Error("The pinned table contract does not include the required strict row operations.");
  }
  return generateTableSdk(table, { contractVersion });
}

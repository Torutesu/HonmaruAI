const TS_TYPES = Object.freeze({
  text: "string", number: "number", date: "string", checkbox: "boolean",
  select: "string", multi_select: "string[]", url: "string", email: "string",
  person: "string", status: "string",
});

function safeType(type) {
  return TS_TYPES[type] || "unknown";
}

function quote(value) {
  return JSON.stringify(String(value));
}

export function generateTableSdk(table) {
  if (!table || typeof table.id !== "string" || !Array.isArray(table.columns)) {
    throw new Error("The table response has no usable schema.");
  }
  const columns = table.columns.filter((column) => column && typeof column.id === "string");
  if (!columns.length) throw new Error("The table has no columns to generate types from.");
  const fields = columns.map((column) => `  ${quote(column.id)}: ${safeType(column.type)};`).join("\n");
  const name = String(table.name || "Honmaru table").replace(/[\r\n]/g, " ");
  return `// Generated from the current Honmaru table contract. Regenerate after schema changes.\n// Table: ${name}\nexport type RowValues = {\n${fields}\n};\n\nexport type HonmaruRow = Omit<RowValues, "id" | "recordId" | "createdAt" | "updatedAt" | "values"> & { id: string; recordId: string; createdAt: string; updatedAt: string; values?: Partial<RowValues> };\nexport type RowPage = { rows: HonmaruRow[]; total: number; nextOffset: number | null; rowVersions: Record<string, string> };\n\nexport type HonmaruClientOptions = { apiUrl: string; token: string; fetcher?: typeof fetch };\nconst TABLE_ID = ${quote(table.id)};\n\n/** Dependency-free typed client for this table's query_rows/add_row/update_row contract. */\nexport function createHonmaruClient({ apiUrl, token, fetcher = fetch }: HonmaruClientOptions) {\n  const endpoint = new URL("/mcp", apiUrl);\n  let requestId = 0;\n  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {\n    const id = ++requestId;\n    const response = await fetcher(endpoint, { method: "POST", redirect: "error", headers: { accept: "application/json, text/event-stream", authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });\n    if (!response.ok) throw new Error("Honmaru API returned HTTP " + response.status + ".");\n    const payload = await response.json() as { id?: number; error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: T } };\n    if (payload.id !== id) throw new Error("Honmaru returned an invalid JSON-RPC response.");\n    if (payload.error) throw new Error(payload.error.message || "Honmaru MCP request failed.");\n    if (payload.result?.isError) throw new Error(payload.result.content?.find((item) => item.type === "text")?.text || "Honmaru tool failed.");\n    if (!payload.result?.structuredContent) throw new Error("Honmaru returned no structured result.");\n    return payload.result.structuredContent;\n  }\n  return {\n    listRows(options: { q?: string; where?: Partial<RowValues>; sort?: string; limit?: number; offset?: number; fields?: Array<keyof RowValues> } = {}) { return call<RowPage>("query_rows", { tableId: TABLE_ID, ...options, ...(options.fields ? { fields: options.fields.map(String) } : {}) }); },\n    createRow(values: Partial<RowValues>) { return call<{ row: HonmaruRow; rowVersions: Record<string, string> }>("add_row", { tableId: TABLE_ID, values }); },\n    updateRow(rowId: string, values: Partial<RowValues>, expectedUpdatedAt?: string) { return call<{ row: HonmaruRow; rowVersions: Record<string, string> }>("update_row", { tableId: TABLE_ID, rowId, values, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) }); },\n  };\n}\n`;
}

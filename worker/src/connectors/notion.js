// Rows in the user's chosen Decisions database. Unlike Gmail and Slack this
// connector cannot work until the user has picked a database, so it declares
// that and the sync loop skips it until they have.

function titleOf(properties) {
  // The title property is identified by type, never by its display name, which
  // is user-defined (e.g. "Name"). Every database has exactly one.
  const entry = Object.values(properties || {}).find((p) => p?.type === "title");
  return (entry?.title || []).map((t) => t.plain_text || "").join("").trim();
}

function firstText(properties) {
  const entry = Object.values(properties || {}).find((p) => p?.type === "rich_text" && p.rich_text?.length);
  return (entry?.rich_text || []).map((t) => t.plain_text || "").join("").trim();
}

export const notion = {
  id: "notion",
  label: "Notion",
  authConfigId: "ac_qtoaZ6G__JEd",
  toolSlug: "NOTION_QUERY_DATABASE_WITH_FILTER",
  // Composio has renamed this tool once already; when the name above is
  // gone, these are tried in turn (and CONNECTOR_TOOL_NOTION pins one).
  fallbackToolSlugs: ["NOTION_QUERY_DATABASE", "NOTION_QUERY_DATA_SOURCE"],
  requiresConfig: true,

  buildArgs(config, slug) {
    // The plain query tool takes the database and a page; the sort shape
    // below is the filtered tool's and is left off for the others.
    if (slug && slug !== "NOTION_QUERY_DATABASE_WITH_FILTER") {
      return { database_id: config?.databaseId, page_size: 10 };
    }
    return {
      database_id: config?.databaseId,
      page_size: 10,
      // "Recent" only holds if we ask Notion to order by it. A system timestamp
      // must go through the tool's TimestampSort shape (a `timestamp` field),
      // NOT a PropertySort with property:"last_edited_time" — the schema rejects
      // that. Bounded to a page of the newest rows; triage judges each one, like
      // Gmail and Slack, since "assigned to me" cannot be done reliably.
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    };
  },

  // SEARCH/QUERY return their payload directly under data; the response_data
  // wrapping only bites NOTION_LIST_USERS. Both are handled, and an empty
  // results array is a valid "nothing shared / nothing new" result.
  parse(payload) {
    const wrapped = payload?.results?.[0]?.response?.data?.results;
    const plain = payload?.data?.results ?? payload?.results;
    const rows = (Array.isArray(wrapped) ? wrapped : Array.isArray(plain) ? plain : []);
    return rows.map((r) => ({
      id: r.id,
      from: "Notion",
      subject: titleOf(r.properties) || "Untitled",
      snippet: firstText(r.properties),
      date: r.last_edited_time || r.created_time || "",
    }));
  },
};

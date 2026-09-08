// Documents someone put in front of you.
//
// A Drive is not a list of decisions either: your own files are not requests,
// and neither is a folder that has sat still for a year. What is a request is
// something *someone else* changed or shared with you recently — the shape of
// "can you look at this before Friday". So this asks for files shared with you,
// newest first, and leaves the judgement to triage.

function sharedSince() {
  return new Date(Date.now() - 7 * 86400_000).toISOString();
}

function sharedBy(file) {
  const other = (file?.owners || []).find((o) => !o?.me);
  return other?.displayName || other?.emailAddress
    || file?.lastModifyingUser?.displayName
    || "Drive";
}

/// A readable kind, from the mime type, for the one line triage gets to read.
function kindOf(mimeType) {
  const map = {
    "application/vnd.google-apps.document": "Doc",
    "application/vnd.google-apps.spreadsheet": "Sheet",
    "application/vnd.google-apps.presentation": "Slides",
    "application/pdf": "PDF",
    "application/vnd.google-apps.folder": "Folder",
  };
  return map[mimeType] || "File";
}

export const googledrive = {
  id: "googledrive",
  label: "Google Drive",
  // As with Calendar: not offered until CONNECTOR_AUTH_GOOGLEDRIVE names one.
  authConfigId: null,
  toolSlug: "GOOGLEDRIVE_LIST_FILES",

  buildArgs() {
    return {
      // Shared with me, still alive, and touched in the last week. Folders are
      // excluded: a folder appearing is a container moving, not a request.
      q: `sharedWithMe and trashed = false and modifiedTime > '${sharedSince()}'`
        + " and mimeType != 'application/vnd.google-apps.folder'",
      pageSize: 10,
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress,me),lastModifyingUser(displayName))",
    };
  },

  parse(payload) {
    const wrapped = payload?.results?.[0]?.response?.data?.files;
    const plain = payload?.data?.files ?? payload?.files;
    const files = Array.isArray(wrapped) ? wrapped : Array.isArray(plain) ? plain : [];
    return files.map((f) => ({
      id: f.id,
      from: sharedBy(f),
      subject: f.name || "(untitled)",
      snippet: [
        `${kindOf(f.mimeType)} shared with you.`,
        f.lastModifyingUser?.displayName ? `Last edited by ${f.lastModifyingUser.displayName}.` : "",
        f.webViewLink || "",
      ].filter(Boolean).join(" ").trim(),
      date: f.modifiedTime || "",
    }));
  },
};

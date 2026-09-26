// What an attached file says, as text, for the workspace's data rules
// (dlp.js): plain text of any kind, and the words inside Word, Excel and
// PowerPoint files (Office Open XML, which is a ZIP of XML). Pictures, PDFs
// and anything else are not read. Nothing extracted here is kept: it is read
// against the rules and dropped.
//
// A ZIP is a promise about sizes that a file can break; every entry is read
// with a cap on what it inflates to, and the whole file with a cap on the
// total, so a small file cannot become a large one here.

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-ndjson|javascript|x-sh|sql))/;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|ndjson|xml|ya?ml|log|ini|conf|env|sql|sh|py|js|ts|tsx|jsx|rb|go|java|kt|swift|c|h|cpp|cs|php|html?|css)$/i;
const OOXML = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
};
const OOXML_NAMES = { docx: OOXML["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], xlsx: OOXML["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], pptx: OOXML["application/vnd.openxmlformats-officedocument.presentationml.presentation"] };

const MAX_TEXT_FILE = 2 * 1024 * 1024;
const MAX_OFFICE_FILE = 15 * 1024 * 1024;
const MAX_ENTRY_INFLATED = 8 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 24 * 1024 * 1024;
const MAX_TEXT_OUT = 1024 * 1024;

/// Which entries of a file to read, or "text", or null for not at all.
export function readerFor(type, name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (OOXML[type]) return OOXML[type];
  if (OOXML_NAMES[ext] && (type === "application/octet-stream" || type === "application/zip" || !type)) return OOXML_NAMES[ext];
  if (TEXT_TYPES.test(type || "") || TEXT_NAMES.test(name || "")) return "text";
  return null;
}

async function inflate(bytes, cap) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => {}); throw new Error("An entry inflates past the limit."); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/// The entries of a ZIP whose names match, inflated, within the caps.
export async function zipEntries(buffer, match) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record, within the last 64 KiB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  let total = 0;
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!match.test(name)) continue;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    const left = MAX_TOTAL_INFLATED - total;
    if (left <= 0) break;
    let inflated;
    if (method === 0) inflated = data.subarray(0, Math.min(data.length, MAX_ENTRY_INFLATED, left));
    else if (method === 8) inflated = await inflate(data, Math.min(MAX_ENTRY_INFLATED, left));
    else continue;
    total += inflated.byteLength;
    out.push({ name, text: new TextDecoder().decode(inflated) });
  }
  return out;
}

/// The words in Office XML: tags gone, paragraphs and cells kept apart.
export function textOfXml(xml) {
  return String(xml)
    .replace(/<\/(w:p|a:p|row|si|c)>/g, "\n")
    .replace(/<(w:tab|w:br)\b[^>]*\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n");
}

/// The text of one file's bytes, or null when it is not read.
export async function fileText(bytes, { type, name }) {
  const how = readerFor(type, name);
  if (!how) return null;
  if (how === "text") {
    if (bytes.byteLength > MAX_TEXT_FILE) return new TextDecoder().decode(new Uint8Array(bytes).subarray(0, MAX_TEXT_FILE));
    return new TextDecoder().decode(bytes);
  }
  if (bytes.byteLength > MAX_OFFICE_FILE) return null;
  try {
    const entries = await zipEntries(bytes, how);
    return entries.map((e) => textOfXml(e.text)).join("\n").slice(0, MAX_TEXT_OUT);
  } catch {
    return null;
  }
}

/// The texts of the files a person is about to send: theirs, uploaded to
/// this conversation and not yet sent.
export async function attachedTexts(env, { orgId, key, login, ids }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && /^f_[0-9a-f]{24}$/.test(x)))].slice(0, 10);
  if (!wanted.length || !env.MEDIA) return [];
  const marks = wanted.map((_, j) => `?${j + 4}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, name, type, size FROM message_files WHERE org_id = ?1 AND channel = ?2 AND uploader = ?3 AND message_id IS NULL AND id IN (${marks})`
  ).bind(orgId, key, login, ...wanted).all();
  const out = [];
  for (const f of results || []) {
    if (!readerFor(f.type, f.name)) continue;
    const obj = await env.MEDIA.get(`file-${f.id}`).catch(() => null);
    if (!obj) continue;
    const text = await fileText(await obj.arrayBuffer(), f);
    if (text) out.push({ name: f.name, text });
  }
  return out;
}

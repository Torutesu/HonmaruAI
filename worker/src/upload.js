// Bytes from a request into R2 without holding them.
//
// Uploads used to be read whole into memory (`readCapped`): every chunk kept,
// then copied once more into one buffer — twice the file, per upload, in an
// isolate that has 128 MB for every request it is serving. Now the length is
// required up front (Content-Length), checked against the cap before a byte
// is read, and the body is piped through a FixedLengthStream into R2: a body
// shorter or longer than it said fails the put, and R2 keeps nothing of a
// put that failed.
//
// The first bytes are looked at on the way through: what a file says it is
// (its Content-Type, which the uploader chose) is only believed when its
// first bytes agree (docs/architecture/media-delivery.md §3, phase 0).

/// The length a request promised, or why it cannot be taken.
/// `{ length }` or `{ status, message }`.
export function promisedLength(request, max) {
  const header = request.headers.get("content-length");
  if (header === null) return { status: 411, message: "Send the file's length (Content-Length)." };
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) return { status: 400, message: "That length is not a number of bytes." };
  if (length === 0) return { status: 400, message: "That file is empty." };
  if (length > max) return { status: 413, message: null };
  return { length };
}

/// The first `n` bytes of a stream (fewer if it is shorter), and a stream
/// that still yields every byte, those included.
export async function peek(body, n) {
  const reader = body.getReader();
  const chunks = [];
  let got = 0;
  let done = false;
  while (got < n) {
    const next = await reader.read();
    if (next.done) { done = true; break; }
    const value = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
    chunks.push(value);
    got += value.byteLength;
  }
  const head = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { head.set(c, at); at += c.byteLength; }
  const stream = new ReadableStream({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value));
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head: head.subarray(0, Math.min(n, head.byteLength)), stream };
}

/// The body, exactly `length` bytes of it, into R2 at `key`. Throws when the
/// body is shorter or longer than that; nothing is stored then.
export function putExactly(env, key, stream, length, httpMetadata) {
  return env.MEDIA.put(key, stream.pipeThrough(new FixedLengthStream(length)), { httpMetadata });
}

// ---- What the first bytes say ----

const ascii = (head, at, text) => {
  if (head.byteLength < at + text.length) return false;
  for (let i = 0; i < text.length; i += 1) if (head[at + i] !== text.charCodeAt(i)) return false;
  return true;
};
const starts = (head, bytes) => head.byteLength >= bytes.length && bytes.every((b, i) => head[i] === b);
const brand = (head) => (ascii(head, 4, "ftyp") && head.byteLength >= 12 ? String.fromCharCode(...head.subarray(8, 12)) : null);

const IMAGE_BRANDS = { "image/avif": ["avif", "avis"], "image/heic": ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"] };
// QuickTime files that do not start with ftyp start with one of these atoms.
const QT_ATOMS = ["moov", "mdat", "free", "wide", "skip", "pnot"];

const isoMedia = (head) => brand(head) !== null || QT_ATOMS.some((a) => ascii(head, 4, a));
const ebml = (head) => starts(head, [0x1a, 0x45, 0xdf, 0xa3]);
const mpegAudio = (head) => ascii(head, 0, "ID3") || (head.byteLength >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
const adts = (head) => ascii(head, 0, "ID3") || (head.byteLength >= 2 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0);
const riff = (head, kind) => ascii(head, 0, "RIFF") && ascii(head, 8, kind);
const text = (head) => !head.includes(0);

const CHECKS = {
  "image/png": (h) => starts(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (h) => starts(h, [0xff, 0xd8, 0xff]),
  "image/gif": (h) => ascii(h, 0, "GIF87a") || ascii(h, 0, "GIF89a"),
  "image/webp": (h) => riff(h, "WEBP"),
  "image/avif": (h) => IMAGE_BRANDS["image/avif"].includes(brand(h)),
  "image/heic": (h) => IMAGE_BRANDS["image/heic"].includes(brand(h)),
  "video/mp4": isoMedia,
  "video/quicktime": isoMedia,
  "video/webm": ebml,
  "audio/mp4": isoMedia,
  "audio/x-m4a": isoMedia,
  "audio/webm": ebml,
  "audio/mpeg": mpegAudio,
  "audio/aac": adts,
  "audio/ogg": (h) => ascii(h, 0, "OggS"),
  "audio/flac": (h) => ascii(h, 0, "fLaC"),
  "audio/wav": (h) => riff(h, "WAVE"),
  "audio/x-wav": (h) => riff(h, "WAVE"),
  "text/plain": text,
};

/// Whether uploads are checked by their first bytes. On unless the
/// MEDIA_SNIFF variable says "off" — the way back if a real file of some kind
/// turns out to start in a way this does not know.
export const sniffing = (env) => String(env?.MEDIA_SNIFF || "").toLowerCase() !== "off";

/// How many bytes `looksLike` needs to see.
export const HEAD_BYTES = 512;

/// Whether a file's first bytes are what its type says. A type this does not
/// know is not vouched for (false).
export function looksLike(type, head) {
  const check = CHECKS[type];
  return Boolean(check && head && head.byteLength && check(head));
}

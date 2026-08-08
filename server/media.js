// Video attached to a decision card.
//
// Deliberately dumb: files land on disk under a random id and are served back
// by that id. There is no database row, because a card already carries the only
// reference that matters and losing the file should degrade to a card without
// video rather than a card that cannot load.

import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MEDIA_DIR = resolve(process.env.MEDIA_STORE_PATH || "./data/media");

// Refuse anything that would take a long time to stream to a phone on the same
// Wi-Fi, and anything large enough to fill the disk by accident.
const MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES || 40 * 1024 * 1024);

function ensureDir() {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
}

/** POST /media — raw video body in, `{ id, url }` out. */
export function uploadMedia(req, res, { publicBaseURL }) {
  ensureDir();

  const id = randomUUID();
  const path = join(MEDIA_DIR, `${id}.mp4`);
  const stream = createWriteStream(path);

  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BYTES) {
      aborted = true;
      stream.destroy();
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `Video is larger than ${MAX_BYTES} bytes.` }));
      req.destroy();
    }
  });

  req.pipe(stream);

  stream.on("finish", () => {
    if (aborted) return;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ id, url: `${publicBaseURL}/media/${id}` }));
  });

  stream.on("error", () => {
    if (aborted) return;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Could not store the video." }));
  });
}

/**
 * GET /media/:id — plays back with range support, without which AVPlayer will
 * not scrub and some versions refuse to start at all.
 */
export function serveMedia(req, res, id) {
  // The id comes off the URL, so anything that is not a plain uuid could walk
  // out of the media directory.
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    res.writeHead(400).end();
    return;
  }

  const path = join(MEDIA_DIR, `${id}.mp4`);
  if (!existsSync(path)) {
    res.writeHead(404).end();
    return;
  }

  const size = statSync(path).size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(path).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match && match[1] ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : size - 1;

  if (start >= size || end >= size || start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }

  res.writeHead(206, {
    "Content-Type": "video/mp4",
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(path, { start, end }).pipe(res);
}

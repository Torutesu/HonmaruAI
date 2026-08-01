import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname, resolve } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolve a URL path to a file inside root, or to index.html (SPA fallback).
 * Returns null when static hosting is off or the path escapes root.
 */
export function resolveStaticFile(root, pathname) {
  if (!root || !existsSync(root)) return null;

  const rootPath = resolve(root);
  const clean = decodeURIComponent(pathname || "/").split("?")[0];
  const candidate = resolve(join(rootPath, normalize(clean)));

  // Path traversal guard: the resolved path must stay under root.
  if (candidate !== rootPath && !candidate.startsWith(rootPath + "/")) return null;

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  // Unknown path with no extension → SPA route, serve the shell.
  if (!extname(clean)) {
    const index = join(rootPath, "index.html");
    if (existsSync(index)) return index;
  }

  return null;
}

export function serveStaticFile(res, filePath, { method = "GET" } = {}) {
  const ext = extname(filePath);
  const immutable = /\.[0-9a-f]{8,}\./i.test(filePath); // hashed build assets

  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": statSync(filePath).size,
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });

  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

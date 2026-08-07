import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

// Single-deployment mode: if the web client build is present, serve it from
// this process. API routes are registered first, so /v1 and /health always
// win; everything else falls back to the SPA's index.html.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST_PATH || join(here, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  const root = relative(process.cwd(), webDist) || ".";
  app.http.use("*", serveStatic({ root }));
  app.http.get(
    "*",
    serveStatic({ root, rewriteRequestPath: () => "/index.html" })
  );
  app.log.info({ webDist }, "serving web client");
}

const server = serve(
  { fetch: app.http.fetch, port: config.port },
  (info) => {
    app.log.info(
      {
        port: info.port,
        devMode: config.authDevMode,
        aiRouting: Boolean(config.openRouter),
        githubOAuth: Boolean(config.github.clientId),
      },
      "honmaru server listening"
    );
  }
) as Server;

app.hub.attach(server);

function shutdown(signal: string): void {
  app.log.info({ signal }, "shutting down");
  server.close(() => {
    app.close();
    process.exit(0);
  });
  // Force-exit if connections refuse to drain.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

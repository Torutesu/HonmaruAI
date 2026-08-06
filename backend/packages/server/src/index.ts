import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

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

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the app runs on :5173 and proxies to the relay, so the browser sees
// one origin — the same shape as production, where the relay serves the build.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ["/ai", "/org", "/auth", "/github", "/push", "/digest", "/escalations", "/health"].map(
        (path) => [path, { target: "http://127.0.0.1:8080", changeOrigin: false }]
      )
    ),
  },
  build: { outDir: "dist", sourcemap: true },
});

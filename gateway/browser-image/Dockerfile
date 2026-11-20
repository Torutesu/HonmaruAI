FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp \
    NODE_ENV=production
WORKDIR /opt/honmaru

RUN apt-get update && apt-get install -y --no-install-recommends \
      iptables util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY browser-image/package.json browser-image/package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf /root/.npm /var/lib/apt/lists/*

COPY browser-image/browser-entrypoint.sh browser-image/browser-proxy-server.mjs browser-image/browser-guest.mjs browser-image/browser-command.mjs browser-image/command-server.mjs browser-session.mjs ./
COPY browser-proxy.mjs ./
RUN chmod 0555 browser-entrypoint.sh && chmod 0444 browser-proxy.mjs browser-proxy-server.mjs browser-guest.mjs browser-command.mjs command-server.mjs browser-session.mjs

ENTRYPOINT ["/opt/honmaru/browser-entrypoint.sh"]

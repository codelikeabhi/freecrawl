# fork: browser sessions behind Hangar's contract (PLAN.md Phase 14).
# Runs user and model-driven code: compose keeps it on an internal network
# whose only way out is egress-proxy, read-only, non-root, no capabilities.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund \
    && npx playwright install chromium --with-deps \
    && npm cache clean --force && rm -rf /var/lib/apt/lists/*
COPY server.js runner.js ./
COPY agent-browser /opt/fork/bin/agent-browser
RUN mkdir -p /sessions /profiles && chown node:node /sessions /profiles \
    && chmod -R a+rX /ms-playwright
# The root file system is read-only. Without a writable config dir Chromium's
# crash handler has no database, and on native Linux the browser then dies at
# start ("chrome_crashpad_handler: --database is required").
ENV XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache
USER node
CMD ["node", "server.js"]

# fork: code sandbox for deterministicJson (PLAN.md Phase 13). Same Node as the API.
# Runs with no network (compose: network_mode none); the API reaches it over a
# Unix socket in a shared volume.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js runner.js ./
RUN mkdir /sandbox && chown node:node /sandbox
USER node
CMD ["node", "server.js"]

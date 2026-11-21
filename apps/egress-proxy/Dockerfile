# fork: egress proxy and CDP relay for browser sessions (PLAN.md Phase 14). No dependencies.
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY server.js .
USER node
CMD ["node", "server.js"]

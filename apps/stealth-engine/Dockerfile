# fork: the stealth engine as a container, for machines without the macOS host
# agent (scripts/fork/stealth.sh). Same code: Patchright drives a headful
# Chrome on a virtual display; on ARM, where Google ships no Linux Chrome, it
# drives Patchright's Chromium. Backend network only, no published port; the
# API calls http://stealth:3003/scrape. Built with the playwright-service-ts
# sources as the extra `service` context (docker-compose.override.yaml).
FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

ARG TARGETARCH
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app/stealth-engine
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb xauth \
  && if [ "$TARGETARCH" = arm64 ]; then pnpm exec patchright install --with-deps chromium; \
     else pnpm exec patchright install --with-deps chrome; fi \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /ms-playwright /profiles && chmod -R a+rX /ms-playwright && chown node:node /profiles

COPY --from=service api.ts /app/playwright-service-ts/api.ts
COPY --from=service helpers /app/playwright-service-ts/helpers

USER node
ENV STEALTH_HOST=0.0.0.0 STEALTH_PROFILE_DIR=/profiles
EXPOSE 3003
CMD ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "pnpm", "start"]

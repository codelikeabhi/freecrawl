# fork: runs API snips against the running compose stack, inside Docker, so the
# host needs no Rust or pnpm toolchain. Built on the upstream API Dockerfile's
# `build` stage (source + compiled native module), with the dev dependencies
# that stage prunes restored from the same pnpm cache. See scripts/fork/snips.sh.
FROM firecrawl-api-build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# The backend image.
#
# Two stages. The first installs the dependencies with the toolchain that
# `better-sqlite3` needs to compile its native binding; the second carries
# only what the server needs to run. The runtime image has no compiler, no
# package manager metadata and no source tree - it is the application and its
# dependencies, nothing else.
#
# The image runs as an unprivileged user, and the directories the application
# writes to are created with the right ownership up front so it never has to
# run as root to fix them.

# --- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# `better-sqlite3` is a native module. It ships prebuilt binaries for the
# common platforms, but if one is not available for this architecture the
# build falls back to compiling, and without these it fails at install time.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The dependency manifests are copied first so the install layer is cached
# until they change.
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci

COPY backend ./backend

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `tini` reaps the zombies a containerised child process leaves behind, and
# forwards the signals the orchestrator sends. Without it, SIGTERM does not
# reach the server and the container has to be killed.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_PATH=/var/lib/ci-investigator/app.db \
    SANDBOX_ROOT=/var/lib/ci-investigator/sandbox \
    LLM_CACHE_DIR=/var/lib/ci-investigator/llm-cache

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
# The dependencies come from the build stage, so the native binding was
# compiled against this same base image and the runtime needs no toolchain.
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/src ./backend/src

# The state directory: the database, the sandbox and the recording cache. It
# is a volume in the compose file, and it belongs to the unprivileged user the
# server runs as.
RUN mkdir -p /var/lib/ci-investigator/sandbox /var/lib/ci-investigator/llm-cache \
    && chown -R node:node /var/lib/ci-investigator
USER node

EXPOSE 4000

# The health endpoint is unauthenticated and reports whether the service is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/src/server.js"]

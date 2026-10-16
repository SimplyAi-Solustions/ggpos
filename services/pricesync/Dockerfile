# pricesync: nightly price file sync into PocketBase.
# Runs once per invocation and exits; scheduled by the host cron line in
# deploy/README.md.
FROM node:22-alpine

WORKDIR /app

# Only production dependencies; the service has no build step. npm ci
# (not npm install) so the build is exactly the committed lockfile, not
# whatever the registry resolves stream-json's range to on the day of the
# build - package-lock.json is committed for this (see CLAUDE.md's
# "Dependencies" note: pricesync's only dependency is stream-json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

# Streamed price files are cached here between runs. Bind-mounted by
# compose (deploy/docker-compose.yml's pricesync.volumes) onto a host
# directory owned the same way - created here, before USER node below,
# and owned by that user so the run-time writes into it (the ETag cache
# body/meta files) do not fail EACCES the first time the volume is empty.
RUN mkdir -p /app/cache && chown node:node /app/cache
VOLUME ["/app/cache"]

USER node

CMD ["node", "src/index.mjs"]

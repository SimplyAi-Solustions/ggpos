# notify: the Web Push sidecar. Unlike pricesync, this is a long-running
# process - src/index.mjs's own mainLoop polls every 60s from inside the
# one container start, rather than the image being invoked fresh per run -
# see deploy/docker-compose.yml's own comment on its "notify" service.
FROM node:22-alpine

WORKDIR /app

# Only production dependencies; the service has no build step. npm ci (not
# npm install) so the build is exactly the committed lockfile, not
# whatever the registry resolves web-push's range to on the day of the
# build - package-lock.json is committed for this, the same reasoning
# services/pricesync's own Dockerfile already follows.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

USER node

CMD ["node", "src/index.mjs"]

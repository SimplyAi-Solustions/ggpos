# pricesync: nightly price file sync into PocketBase.
# Runs once per invocation and exits; scheduled by the host cron line in
# deploy/README.md.
FROM node:22-alpine

WORKDIR /app

# Only production dependencies; the service has no build step.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Streamed price files are cached here between runs (bind-mounted by compose).
VOLUME ["/app/cache"]

USER node

CMD ["node", "src/index.mjs"]

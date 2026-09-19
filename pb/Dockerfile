# GG Vault PocketBase backend.
#
# Downloads the pinned PocketBase binary at build time (no Go toolchain
# needed) and bakes in this repo's hooks, migrations and the built PWA
# (pb_public). pb_data is a volume, so the SQLite database and uploaded
# files survive an image rebuild or redeploy.
#
# Build:  docker build -t gg-vault-pb --build-arg PB_VERSION=0.40.4 -f pb/Dockerfile .
# Run:    docker run -p 8090:8090 -v gg_pb_data:/pb/pb_data gg-vault-pb
#
# Architecture is detected from `uname -m` at build time (amd64/arm64),
# the same approach as pb/scripts/dev.sh - this assumes a native build,
# not a cross-arch buildx one; swap in $TARGETARCH if that changes.
FROM alpine:3.20

ARG PB_VERSION=0.40.4

# ca-certificates stays in the final image: PocketBase itself makes
# outbound HTTPS calls (FX rates, card/price adapters). curl and unzip
# are build-only tools, removed once the binary is extracted.
RUN apk add --no-cache ca-certificates \
  && apk add --no-cache --virtual .fetch-deps curl unzip \
  && ARCH="$(uname -m)" \
  && case "$ARCH" in \
       x86_64) PB_ARCH=amd64 ;; \
       aarch64) PB_ARCH=arm64 ;; \
       *) echo "Unsupported architecture: $ARCH" >&2 && exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/pocketbase.zip \
       "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
  && mkdir -p /pb \
  && unzip -q /tmp/pocketbase.zip pocketbase -d /pb \
  && rm /tmp/pocketbase.zip \
  && chmod +x /pb/pocketbase \
  && apk del .fetch-deps

WORKDIR /pb
RUN mkdir -p pb_public

COPY pb_hooks ./pb_hooks
COPY pb_migrations ./pb_migrations
# pb_public (the built PWA) is git-ignored and does not exist at all on a
# fresh checkout before apps/web has a build step wired to it. The [c]
# bracket-glob is the standard Dockerfile idiom for "copy this if it
# exists": it matches the literal name "pb_public" when present and
# matches nothing (no error) when the directory is absent, unlike a plain
# `COPY pb_public ./pb_public`, which fails the build outright if it's
# missing.
COPY pb_publi[c] ./pb_public

EXPOSE 8090
VOLUME /pb/pb_data

ENTRYPOINT ["/pb/pocketbase", "serve", \
  "--http", "0.0.0.0:8090", \
  "--dir", "/pb/pb_data", \
  "--hooksDir", "/pb/pb_hooks", \
  "--migrationsDir", "/pb/pb_migrations", \
  "--publicDir", "/pb/pb_public"]

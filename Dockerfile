# Single image: the mutiny-sidecar serves the built web app and proxies the
# wallet's JSON calls to ldk-server. Mount ldk-server's data dir read-only so
# the sidecar can read tls.crt and <network>/api_key.
#
#   docker build -t mutiny-web .
#   docker run -p 8890:8890 \
#     -v "$HOME/Library/Application Support/ldk-server:/data:ro" \
#     -v mutiny-sidecar:/state \
#     -e LDK_DATA_DIR=/data -e LDK_NETWORK=bitcoin \
#     -e LDK_GRPC_ADDRESS=host.docker.internal:3536 \
#     -e WALLET_PASSWORD=change-me -e WALLET_PUBLIC_URL=https://wallet.example.com \
#     mutiny-web

# ---- 1. Web app ----------------------------------------------------------------
FROM node:24-slim AS web
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_COMMIT_HASH=docker
ENV VITE_COMMIT_HASH=$VITE_COMMIT_HASH
RUN pnpm run build

# ---- 2. Sidecar ----------------------------------------------------------------
FROM rust:1-bookworm AS sidecar
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release

# ---- 3. Runtime ----------------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=sidecar /build/target/release/mutiny-sidecar /usr/local/bin/mutiny-sidecar
COPY --from=web /app/dist /web
ENV WEB_DIR=/web
ENV WALLET_DATA_DIR=/state
ENV PORT=8890
VOLUME ["/state"]
EXPOSE 8890
CMD ["mutiny-sidecar"]

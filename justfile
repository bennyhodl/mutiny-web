set dotenv-load := false

# Web app with hot reload. Expects a sidecar on http://127.0.0.1:8890.
dev:
    pnpm run dev

# Build and run the sidecar against ldk-server. Set WALLET_PASSWORD or WALLET_AUTH=off.
sidecar *ARGS:
    cd server && cargo run --release -- {{ARGS}}

pre:
    pnpm run pre-commit

native:
    pnpm install && pnpm build && npx cap sync

# ---- Private regtest stack (bitcoind + electrs + two ldk-server nodes) ----

regtest-up:
    docker compose -f regtest/docker-compose.yml up -d
    regtest/btc createwallet default || regtest/btc loadwallet default || true

regtest-down:
    docker compose -f regtest/docker-compose.yml down

regtest-mine BLOCKS="1":
    regtest/btc mine {{BLOCKS}}

regtest-fund ADDRESS AMOUNT="1.0":
    regtest/btc fund {{ADDRESS}} {{AMOUNT}}
    regtest/btc mine 1

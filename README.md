# Mutiny Web

Mutiny Web is a Lightning wallet UI for an [ldk-server](https://github.com/lightningdevkit/ldk-server) node.
The node holds the keys and does the Lightning work. The app is a remote control for it.

It used to embed a node as WebAssembly. That runtime is gone. Instead, a small Rust
**sidecar** runs next to ldk-server, holds its secrets, and serves the wallet as JSON.

```
┌──────────────────────┐   JSON + SSE    ┌───────────────────┐   gRPC / HTTP2 / TLS   ┌────────────┐
│  mutiny-web (Solid)  │ ──────────────▶ │  mutiny-sidecar   │ ──── + HMAC x-auth ──▶ │ ldk-server │
│  browser / Capacitor │ ◀────────────── │  (server/, Rust)  │ ◀───────────────────── │  :3536     │
└──────────────────────┘                 └───────────────────┘   (cert pinned)        └────────────┘
```

A browser cannot speak native gRPC, cannot pin a self-signed certificate, and must never
hold the ldk-server `api_key`. The sidecar does all three with the official
`ldk-server-client` crate, and exposes:

| Route                    | What                                                |
| ------------------------ | --------------------------------------------------- |
| `POST /api/rpc/<Method>` | One JSON endpoint per ldk-server RPC                |
| `GET  /api/events`       | Node events as Server-Sent Events                   |
| `GET  /api/config`       | `{ network }`                                       |
| `POST /api/auth/login`   | Password sign-in, sets an `HttpOnly` session cookie |
| `GET  /api/connections`  | NWC connection string and Lightning Address         |
| `/.well-known/lnurlp/*`  | Lightning Address, public (see Taking payments)     |
| `/`                      | The built web app (when `WEB_DIR` is set)           |

## What the wallet does

- Balances: on-chain, Lightning, pending channel closes
- Receive: BOLT11 invoice, on-chain address (BIP21), BOLT12 offer
- Send: BOLT11, BOLT12 offer, keysend to a node id, on-chain address, BIP21
- Activity list and payment details
- Channels: list, open, close, force close; peers: connect, disconnect
- Node info and sign-out
- Take payments from apps such as Zaprite: Nostr Wallet Connect and a Lightning Address,
  both receive-only (Settings → Connect apps)

Not included (nothing to back them in ldk-server): Fedimint, Nostr contacts, LNURL
pay/withdraw from the wallet, payjoin, Mutiny+, seed backup and restore. The node owns the
seed.

## Run it

### 1. Run ldk-server

See the [ldk-server docs](https://github.com/lightningdevkit/ldk-server/tree/main/docs).
The sidecar reads ldk-server's `config.toml` to find the data dir, network, gRPC address,
`tls.crt` and `api_key`.

### 2. Run the sidecar

```bash
cd server
cp .env.example .env            # optional: override discovery
WALLET_PASSWORD=change-me cargo run --release
```

`WALLET_PASSWORD` is required. Anything that reaches `/api/rpc/*` can spend from the node.
`WALLET_AUTH=off` disables sign-in for local development and forces the listener onto
`127.0.0.1`. Point at a non-default ldk-server config with `LDK_CONFIG=/path/to/config.toml`.
See `server/.env.example` for every option.

**Passkeys.** Sign in with the password once, then open Settings → Security and add a
passkey. From then on the login screen offers "Sign in with passkey". Passkeys and the
session secret live in `WALLET_DATA_DIR`. `WALLET_PUBLIC_URL` is the WebAuthn relying
party, so it must be the exact URL the browser uses (scheme, host, port).

### 3. Run the web app

Development, with hot reload (Vite proxies `/api` to the sidecar on `127.0.0.1:8890`).
Needs Node 22 or newer (`.nvmrc` says 24) and pnpm via corepack:

```bash
corepack enable
pnpm install
pnpm run dev                    # http://localhost:3420
```

Production, served by the sidecar itself:

```bash
pnpm run build
cd server && WEB_DIR=../dist WALLET_PASSWORD=change-me cargo run --release
```

Or as one container:

```bash
docker build -t mutiny-web .
docker run -p 8890:8890 \
  -v "$HOME/Library/Application Support/ldk-server:/data:ro" \
  -v mutiny-sidecar:/state \
  -e LDK_DATA_DIR=/data -e LDK_NETWORK=bitcoin \
  -e LDK_GRPC_ADDRESS=host.docker.internal:3536 \
  -e WALLET_PASSWORD=change-me -e WALLET_PUBLIC_URL=https://wallet.example.com \
  mutiny-web
```

Serve it over HTTPS: an `https://` `WALLET_PUBLIC_URL` is what marks the session cookie
`Secure`. Front the sidecar with Caddy or similar.

## Taking payments (Zaprite)

The sidecar can take payments for the node from outside apps such as Zaprite, two ways.
Both are **receive-only**: they create invoices and report on them, and never call a send
RPC. The wallet shows both under Settings → Connect apps.

**Lightning Address** (LUD-16 over LNURL-pay, with LUD-21 `verify` so the payer can
confirm settlement). The domain is the host of `WALLET_PUBLIC_URL`:

```bash
WALLET_PUBLIC_URL=https://wallet.example.com
WALLET_LNURL_USERNAME=bitcoinbay              # -> bitcoinbay@wallet.example.com
```

These routes are public by design. Payers fetch `/.well-known/lnurlp/<username>` from
that host over HTTPS.

**Nostr Wallet Connect** (NIP-47):

```bash
WALLET_NWC_RELAY=wss://relay.getalby.com/v1
```

It answers `get_info`, `make_invoice`, `lookup_invoice` and `list_transactions`, publishes
`payment_received` notifications, and speaks both nip44 and nip04. Anything that would
spend gets `RESTRICTED`.

Its keys are **derived from ldk-server's mnemonic** (`<ldk data dir>/keys_mnemonic`,
override with `LDK_MNEMONIC_PATH`), so there is still one seed to back up. The paths follow
NIP-06 on a dedicated account: the wallet key is `m/44'/1237'/47'/0/0`, the connection key
`m/44'/1237'/47'/1/<n>`. The connection string is a credential. To revoke it, set
`WALLET_NWC_CONNECTION=<n+1>` and paste the new one into the app. This means the sidecar
reads the node's master secret; it already held the api_key, which can spend everything.

`cargo test` in `server/` runs both flows end to end: the real sidecar binary against a
real bitcoind and two ldk-server nodes over a funded channel, paired the way Zaprite
pairs. The first run builds ldk-server and downloads bitcoind.

## Private regtest stack

`regtest/` has a docker compose file with bitcoind and electrs on offset ports, plus two
ldk-server configs (`wallet` and `peer`). With a built ldk-server checkout next door:

```bash
just regtest-up                 # bitcoind + electrs
just regtest-mine 101
ldk-server regtest/ldk/wallet.toml &
ldk-server regtest/ldk/peer.toml &
cd server && LDK_CONFIG=../regtest/ldk/wallet.toml WALLET_AUTH=off cargo run
```

`regtest/btc` wraps `bitcoin-cli` (`regtest/btc mine 6`, `regtest/btc fund <addr> 1.0`) and
`regtest/peer` wraps `ldk-server-cli` for the peer node.

## Known limits

- ldk-server's `ListPayments` only lists payments that produced a node event. On-chain
  transactions produce none, so the activity list shows on-chain sends made from this
  wallet (their txids are kept in local storage) but not on-chain receives or channel
  funding transactions. The balance is always right.
- The node records an on-chain send only at its next wallet sync, so payment details for
  a fresh send appear after about a minute.
- On-chain receive detection watches the balance, not the address.
- ldk-server doesn't store invoice strings, so the sidecar keeps the ones it issues to NWC
  and Lightning Address payers in memory. After a restart, lookups and `verify` still report
  settlement and the preimage, but not the invoice string of earlier invoices.

## Contributing

Before committing make sure to run `pnpm run pre-commit`. This will typecheck, lint, and
format everything so CI won't hassle you. (Shortcut: `just pre`.) For the sidecar,
`cargo fmt`, `cargo clippy` and `cargo test` in `server/`.

## Android

### How to test locally

```
just native
```

Now open up the `android` directory in android studio and run the build

### Deploying

#### Pull Requests

Each pull request will build the debug signet app and upload it internally to the github actions run.

#### Master

Each push to master will build a signed release version running in signet mode. The build process is almost identical to the release version.

Prereleased tags will be created for master.

#### Release

##### Android

First bump up the `versionCode` and `versionName` in `./andriod/app/build.gradle`. The `versionCode` must always go up by one when making a release. The `versionName` can mimic `package.json` with an extra build number like `0.4.3-1` to make it easier to keep things looking like they are in sync when android only releases go out.

Publish a new tag like `0.4.3-1` in order to trigger a signed release version running in mainnet mode.

##### iOS

In `ios/App/App.xcodeproj/project.pbxproj` bump `MARKETING_VERSION` and then do whatever needs to be done in testflight to get it released.

### Creating keys for the first time

1. Generate a new signing key

```
keytool -genkey -v -keystore <my-release-key.keystore> -alias <alias_name> -keyalg RSA -keysize 2048 -validity 10000
openssl base64 < <my-release-key.keystore> | tr -d '\n' | tee some_signing_key.jks.base64.txt
```

2. Create 3 Secret Key variables on your GitHub repository and fill in with the signing key information
    - `KEY_ALIAS` <- `<alias_name>`
    - `KEY_STORE_PASSWORD` <- `<your key store password>`
    - `SIGNING_KEY` <- the data from `<my-release-key.keystore>`
3. Change the `versionCode` and `versionName` on `app/build.gradle`
4. Commit and push.

## Translating

### Adding new languages or keys

1. In `public/i18n/` locate your desired language .json file or create one if one does not exist

    - When creating a new language file ensure it follows the ISO 639 2-letter standard

2. Populate your translation file with a translation object where all of the keys will be located

If you want to add Japanese you will create a file `/public/i18n/jp.json` and populate it with keys like so:

```
{
  "common": {
        "continue": "続ける",
        ...
    }
}
```

(You should compare your translations against the English language as all other languages are not the master and are likely deprecated)

If you're using VS Code there are some nice extensions that can make this easier like i18n-ally and i18n-json-editor

3. Add your language to the `Language` object in `/src/utils/languages.ts`. This will allow you to select the language via the language selector in the UI. If your desired language is set as your primary language in your browser it will be selected automatically

```
export const LANGUAGE_OPTIONS: Language[] = [
    {
        value: "日本語",
        shortName: "jp"
    },
```

4. That's it! You should now be able to see your translation keys populating the app in your desired language. When youre ready go ahead and open a PR to have you language merged for others!

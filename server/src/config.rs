use std::fs;
use std::path::{Path, PathBuf};

/// Connection settings + secrets for reaching ldk-server.
///
/// By default this mirrors ldk-server's own discovery so it "just works" against a
/// standard install with zero configuration:
///
///   - Config file:  <default_data_dir>/config.toml   (override: LDK_CONFIG)
///   - storage_dir:  [storage.disk] dir_path in that config, else <default_data_dir>
///   - network:      [node] network in that config, else auto-detected
///   - tls.crt:      <storage_dir>/tls.crt
///   - api_key:      <storage_dir>/<network>/api_key   (note: in the network subdir!)
///   - gRPC addr:    [node] grpc_service_address, else 127.0.0.1:3536
///
/// where <default_data_dir> is:
///   - macOS:  ~/Library/Application Support/ldk-server
///   - else:   ~/.ldk-server
///
/// Every value can be overridden by an env var (see below); explicit env always wins.
pub struct Config {
    pub grpc_address: String,
    pub tls_cert: Vec<u8>,
    pub api_key: String,
    pub network: String,
    pub port: u16,
    pub web_origin: String,
    /// Directory of the built web app (index.html + assets). When set and present,
    /// the sidecar serves the SPA from "/" so one binary hosts both. Set via WEB_DIR.
    pub web_dir: Option<PathBuf>,
    pub auth: Auth,
    /// Nostr Wallet Connect, when WALLET_NWC_RELAY is set.
    pub nwc: Option<crate::nwc::Settings>,
    /// Lightning Address, when WALLET_LNURL_USERNAME is set.
    pub lnurl: Option<crate::lnurl::Settings>,
}

/// Who is allowed to drive the node.
///
/// This sidecar holds ldk-server's api_key, so anything that reaches `/api/rpc/*`
/// can spend from the node. Auth is therefore **required by default** —
/// `WALLET_AUTH=off` is the only way to disable it, and doing so also forces the
/// listener onto loopback (see main.rs).
#[allow(clippy::large_enum_variant)]
pub enum Auth {
    Disabled,
    Password(PasswordAuth),
}

pub struct PasswordAuth {
    pub password: String,
    /// HMAC key for signing session cookies.
    pub session_secret: Vec<u8>,
    /// Externally-visible origin. Decides the cookie's Secure flag and the
    /// WebAuthn relying party id.
    pub public_url: String,
    pub session_ttl: std::time::Duration,
    pub passkeys: crate::passkeys::Passkeys,
}

impl PasswordAuth {
    /// Only send the session cookie over TLS when we're actually served over TLS.
    /// (Without this, http://localhost dev logins would silently never stick.)
    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}

fn load_auth(public_url: Option<&str>) -> anyhow::Result<Auth> {
    match std::env::var("WALLET_AUTH").unwrap_or_else(|_| "password".into()).as_str() {
        "off" => Ok(Auth::Disabled),
        "password" => {
            let password = std::env::var("WALLET_PASSWORD").map_err(|_| {
                anyhow::anyhow!(
                    "WALLET_PASSWORD is required when WALLET_AUTH=password (the default). \
                     This sidecar can spend from your node, so it refuses to serve \
                     unauthenticated. Set a password or set WALLET_AUTH=off to run loopback-only."
                )
            })?;
            if password.len() < 8 {
                anyhow::bail!("WALLET_PASSWORD must be at least 8 characters");
            }
            let public_url = public_url.unwrap_or("http://localhost:3420").to_string();
            let data_dir = wallet_data_dir()?;

            // A persistent secret keeps sessions valid across restarts. Without an
            // explicit one we generate a key once and keep it in the data dir.
            let session_secret = match std::env::var("WALLET_SESSION_SECRET") {
                Ok(hex) => {
                    let bytes = decode_hex(hex.trim()).ok_or_else(|| {
                        anyhow::anyhow!("WALLET_SESSION_SECRET must be a hex string")
                    })?;
                    if bytes.len() < 32 {
                        anyhow::bail!(
                            "WALLET_SESSION_SECRET must be at least 32 bytes (64 hex chars); \
                             generate one with `openssl rand -hex 32`"
                        );
                    }
                    bytes
                }
                Err(_) => load_or_create_session_secret(&data_dir)?,
            };

            let passkeys = crate::passkeys::Passkeys::new(&public_url, data_dir)?;

            let session_ttl = std::time::Duration::from_secs(
                60 * 60
                    * std::env::var("WALLET_SESSION_TTL_HOURS")
                        .ok()
                        .and_then(|h| h.parse::<u64>().ok())
                        .unwrap_or(24 * 30),
            );

            tracing::info!("auth: password, public url {public_url}");
            Ok(Auth::Password(PasswordAuth {
                password,
                session_secret,
                public_url,
                session_ttl,
                passkeys,
            }))
        }
        other => anyhow::bail!("WALLET_AUTH must be `password` or `off`, got `{other}`"),
    }
}

/// Where the sidecar keeps its own state (passkeys, session secret).
/// WALLET_DATA_DIR, else ~/Library/Application Support/mutiny-sidecar on macOS,
/// ~/.mutiny-sidecar elsewhere.
fn wallet_data_dir() -> anyhow::Result<PathBuf> {
    if let Ok(dir) = std::env::var("WALLET_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    #[allow(deprecated)]
    let home =
        std::env::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir; set WALLET_DATA_DIR"))?;
    Ok(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/mutiny-sidecar")
    } else {
        home.join(".mutiny-sidecar")
    })
}

fn load_or_create_session_secret(data_dir: &Path) -> anyhow::Result<Vec<u8>> {
    let path = data_dir.join("session_secret");
    match fs::read(&path) {
        Ok(bytes) if bytes.len() >= 32 => return Ok(bytes),
        Ok(_) => tracing::warn!("{} is too short, regenerating", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => anyhow::bail!("reading {}: {e}", path.display()),
    }
    use rand::RngCore;
    let mut buf = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    fs::create_dir_all(data_dir)
        .map_err(|e| anyhow::anyhow!("creating {}: {e}", data_dir.display()))?;
    fs::write(&path, &buf).map_err(|e| anyhow::anyhow!("writing {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    tracing::info!("generated a session secret at {}", path.display());
    Ok(buf)
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

const NETWORKS: &[&str] = &["bitcoin", "testnet", "testnet4", "signet", "regtest"];

/// Mirrors ldk-server's `get_default_data_dir()`.
fn default_data_dir() -> Option<PathBuf> {
    #[allow(deprecated)]
    let home = std::env::home_dir()?;
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Application Support/ldk-server"))
    } else {
        Some(home.join(".ldk-server"))
    }
}

/// The subset of ldk-server's config.toml we care about.
#[derive(serde::Deserialize, Default)]
struct LdkServerConfig {
    node: Option<NodeSection>,
    storage: Option<StorageSection>,
}
#[derive(serde::Deserialize, Default)]
struct NodeSection {
    network: Option<String>,
    grpc_service_address: Option<String>,
}
#[derive(serde::Deserialize, Default)]
struct StorageSection {
    disk: Option<DiskSection>,
}
#[derive(serde::Deserialize, Default)]
struct DiskSection {
    dir_path: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        // 1. Locate + parse ldk-server's config (best-effort; missing is fine if env covers it).
        let config_path = std::env::var("LDK_CONFIG")
            .map(PathBuf::from)
            .ok()
            .or_else(|| default_data_dir().map(|d| d.join("config.toml")));

        let parsed: LdkServerConfig = match &config_path {
            Some(p) if p.exists() => {
                let text = fs::read_to_string(p)
                    .map_err(|e| anyhow::anyhow!("reading {}: {e}", p.display()))?;
                tracing::info!("using ldk-server config at {}", p.display());
                toml::from_str(&text)
                    .map_err(|e| anyhow::anyhow!("parsing {}: {e}", p.display()))?
            }
            _ => LdkServerConfig::default(),
        };
        let node = parsed.node.unwrap_or_default();

        // 2. storage_dir: env > config dir_path > default data dir.
        let storage_dir: PathBuf = std::env::var("LDK_DATA_DIR")
            .map(PathBuf::from)
            .ok()
            .or_else(|| {
                parsed.storage.and_then(|s| s.disk).and_then(|d| d.dir_path).map(PathBuf::from)
            })
            .or_else(default_data_dir)
            .ok_or_else(|| {
                anyhow::anyhow!("could not determine ldk-server data dir; set LDK_DATA_DIR")
            })?;

        // 3. gRPC address: env > config > default.
        let grpc_address = std::env::var("LDK_GRPC_ADDRESS")
            .ok()
            .or(node.grpc_service_address)
            .unwrap_or_else(|| "127.0.0.1:3536".into());

        // 4. tls.crt: env override, else <storage_dir>/tls.crt.
        let tls_cert_path = std::env::var("LDK_TLS_CERT_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| storage_dir.join("tls.crt"));
        let tls_cert = fs::read(&tls_cert_path).map_err(|e| {
            anyhow::anyhow!(
                "reading tls.crt at {} ({e}). Is ldk-server installed here? \
                 Override with LDK_TLS_CERT_PATH or LDK_DATA_DIR.",
                tls_cert_path.display()
            )
        })?;

        // 5. network: env > config > auto-detect the subdir holding an api_key.
        let network = std::env::var("LDK_NETWORK")
            .ok()
            .or(node.network)
            .or_else(|| detect_network(&storage_dir))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "could not determine network subdir under {}; set LDK_NETWORK",
                    storage_dir.display()
                )
            })?;

        // 6. api_key: env (hex) > env path > <storage_dir>/<network>/api_key.
        let api_key = if let Ok(key) = std::env::var("LDK_API_KEY") {
            key
        } else {
            let api_key_path = std::env::var("LDK_API_KEY_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| storage_dir.join(&network).join("api_key"));
            let bytes = fs::read(&api_key_path).map_err(|e| {
                anyhow::anyhow!(
                    "reading api_key at {} ({e}). Override with LDK_API_KEY or LDK_API_KEY_PATH.",
                    api_key_path.display()
                )
            })?;
            // 32 raw bytes; ldk-server uses their lowercase hex as the HMAC key.
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        };

        let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8890);
        let web_origin =
            std::env::var("WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:3420".into());
        let web_dir = std::env::var("WEB_DIR").ok().map(PathBuf::from).filter(|p| p.is_dir());

        // The URL the wallet is served at, without a trailing slash. Passkeys and the
        // Lightning Address both build on it.
        let public_url = set_var("WALLET_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string());
        let auth = load_auth(public_url.as_deref())?;

        // NWC keys come from ldk-server's own mnemonic, so there is one seed to back up.
        let nwc = match set_var("WALLET_NWC_RELAY") {
            None => None,
            Some(relay) => {
                let relay = nostr::types::RelayUrl::parse(relay.trim())
                    .map_err(|e| anyhow::anyhow!("WALLET_NWC_RELAY is not a relay URL ({e})"))?;
                let mnemonic_path = std::env::var("LDK_MNEMONIC_PATH")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| storage_dir.join("keys_mnemonic"));
                let mnemonic = fs::read_to_string(&mnemonic_path).map_err(|e| {
                    anyhow::anyhow!(
                        "reading ldk-server's mnemonic at {} ({e}). NWC derives its keys from \
                         it; override with LDK_MNEMONIC_PATH.",
                        mnemonic_path.display()
                    )
                })?;
                let connection = match set_var("WALLET_NWC_CONNECTION") {
                    Some(n) => n.trim().parse::<u32>().map_err(|_| {
                        anyhow::anyhow!("WALLET_NWC_CONNECTION must be a non-negative integer")
                    })?,
                    None => 0,
                };
                Some(crate::nwc::Settings::from_mnemonic(relay, &mnemonic, connection)?)
            }
        };

        let lnurl = match set_var("WALLET_LNURL_USERNAME") {
            None => None,
            Some(username) => {
                let public_url = public_url.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "WALLET_LNURL_USERNAME needs WALLET_PUBLIC_URL: payers fetch the \
                         Lightning Address from that origin"
                    )
                })?;
                Some(crate::lnurl::Settings::new(&username, public_url)?)
            }
        };

        Ok(Self {
            grpc_address,
            tls_cert,
            api_key,
            network,
            port,
            web_origin,
            web_dir,
            auth,
            nwc,
            lnurl,
        })
    }
}

/// An env var that is set to something. docker-compose passes unset variables
/// through as empty strings, which must mean "off", not "invalid".
fn set_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Find the single network subdir under `storage_dir` that contains an `api_key` file.
fn detect_network(storage_dir: &Path) -> Option<String> {
    let found: Vec<&str> = NETWORKS
        .iter()
        .copied()
        .filter(|net| storage_dir.join(net).join("api_key").exists())
        .collect();
    match found.as_slice() {
        [one] => Some((*one).to_string()),
        [] => None,
        many => {
            tracing::warn!(
                "multiple networks found under {} ({:?}); set LDK_NETWORK to disambiguate. Using {}",
                storage_dir.display(),
                many,
                many[0]
            );
            Some(many[0].to_string())
        }
    }
}

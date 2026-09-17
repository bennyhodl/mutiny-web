//! Passkeys (WebAuthn) for the wallet.
//!
//! One wallet, one password, any number of passkeys. A passkey is registered
//! from a signed-in session (so the password gates enrolment) and can then sign
//! in on its own. Passkeys persist as JSON in the sidecar data dir; the
//! challenge state between `start` and `finish` lives in memory for a minute.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use url::Url;
use webauthn_rs::prelude::*;

const CHALLENGE_TTL: Duration = Duration::from_secs(120);

#[derive(Serialize, Deserialize, Clone)]
pub struct StoredPasskey {
    /// Base64url credential id, used as the handle in the API.
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub passkey: Passkey,
}

/// What the UI gets to see about a passkey.
#[derive(Serialize)]
pub struct PasskeyInfo {
    pub id: String,
    pub name: String,
    pub created_at: u64,
}

pub struct Passkeys {
    webauthn: Webauthn,
    path: PathBuf,
    keys: Mutex<Vec<StoredPasskey>>,
    pending_reg: Mutex<HashMap<String, (Instant, PasskeyRegistration)>>,
    pending_auth: Mutex<HashMap<String, (Instant, PasskeyAuthentication)>>,
}

#[derive(Debug)]
pub struct PasskeyError(pub String);

impl From<WebauthnError> for PasskeyError {
    fn from(e: WebauthnError) -> Self {
        PasskeyError(e.to_string())
    }
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_id() -> String {
    use rand::RngCore;
    let mut raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

impl Passkeys {
    /// `public_url` decides the relying party id (its host) and the allowed origin.
    pub fn new(public_url: &str, data_dir: PathBuf) -> anyhow::Result<Self> {
        let origin = Url::parse(public_url)
            .map_err(|e| anyhow::anyhow!("WALLET_PUBLIC_URL is not a URL: {e}"))?;
        let rp_id = origin
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("WALLET_PUBLIC_URL has no host"))?
            .to_string();

        let mut builder = WebauthnBuilder::new(&rp_id, &origin)
            .map_err(|e| anyhow::anyhow!("webauthn setup: {e}"))?
            .rp_name("Mutiny Wallet");
        // Local development runs Vite and the sidecar on different ports of
        // the same host. Browsers only offer passkeys on http for localhost,
        // so this relaxation cannot reach a real deployment.
        if origin.scheme() == "http" {
            builder = builder.allow_any_port(true);
        }
        let webauthn = builder.build().map_err(|e| anyhow::anyhow!("webauthn setup: {e}"))?;

        fs::create_dir_all(&data_dir)
            .map_err(|e| anyhow::anyhow!("creating {}: {e}", data_dir.display()))?;
        let path = data_dir.join("passkeys.json");
        let keys: Vec<StoredPasskey> = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => anyhow::bail!("reading {}: {e}", path.display()),
        };
        tracing::info!("passkeys: rp_id {rp_id}, {} registered ({})", keys.len(), path.display());

        Ok(Self {
            webauthn,
            path,
            keys: Mutex::new(keys),
            pending_reg: Mutex::new(HashMap::new()),
            pending_auth: Mutex::new(HashMap::new()),
        })
    }

    fn save(&self, keys: &[StoredPasskey]) -> Result<(), PasskeyError> {
        let json = serde_json::to_vec_pretty(keys).map_err(|e| PasskeyError(e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json)
            .and_then(|_| fs::rename(&tmp, &self.path))
            .map_err(|e| PasskeyError(format!("saving passkeys: {e}")))
    }

    pub fn list(&self) -> Vec<PasskeyInfo> {
        self.keys
            .lock()
            .expect("lock")
            .iter()
            .map(|k| PasskeyInfo {
                id: k.id.clone(),
                name: k.name.clone(),
                created_at: k.created_at,
            })
            .collect()
    }

    pub fn has_any(&self) -> bool {
        !self.keys.lock().expect("lock").is_empty()
    }

    pub fn delete(&self, id: &str) -> Result<(), PasskeyError> {
        let mut keys = self.keys.lock().expect("lock");
        let before = keys.len();
        keys.retain(|k| k.id != id);
        if keys.len() == before {
            return Err(PasskeyError("no such passkey".into()));
        }
        self.save(&keys)
    }

    /// Step 1 of enrolment. Returns the challenge id and the options for
    /// `navigator.credentials.create()`.
    pub fn start_registration(&self) -> Result<(String, CreationChallengeResponse), PasskeyError> {
        let exclude: Vec<CredentialID> =
            self.keys.lock().expect("lock").iter().map(|k| k.passkey.cred_id().clone()).collect();
        // Passkeys are per wallet, so the "user" is the wallet itself.
        let user_id = Uuid::new_v5(
            &Uuid::NAMESPACE_DNS,
            self.webauthn.get_allowed_origins()[0].as_str().as_bytes(),
        );
        let (ccr, state) = self.webauthn.start_passkey_registration(
            user_id,
            "wallet",
            "Mutiny Wallet",
            if exclude.is_empty() { None } else { Some(exclude) },
        )?;
        let id = random_id();
        let mut pending = self.pending_reg.lock().expect("lock");
        pending.retain(|_, (t, _)| t.elapsed() < CHALLENGE_TTL);
        pending.insert(id.clone(), (Instant::now(), state));
        Ok((id, ccr))
    }

    /// Step 2 of enrolment.
    pub fn finish_registration(
        &self,
        challenge_id: &str,
        name: &str,
        credential: &RegisterPublicKeyCredential,
    ) -> Result<PasskeyInfo, PasskeyError> {
        let (started, state) = self
            .pending_reg
            .lock()
            .expect("lock")
            .remove(challenge_id)
            .ok_or_else(|| PasskeyError("unknown or expired challenge".into()))?;
        if started.elapsed() > CHALLENGE_TTL {
            return Err(PasskeyError("challenge expired".into()));
        }
        let passkey = self.webauthn.finish_passkey_registration(credential, &state)?;
        let stored = StoredPasskey {
            id: URL_SAFE_NO_PAD.encode(passkey.cred_id().as_ref()),
            name: if name.trim().is_empty() { "Passkey".into() } else { name.trim().to_string() },
            created_at: now_unix(),
            passkey,
        };
        let info = PasskeyInfo {
            id: stored.id.clone(),
            name: stored.name.clone(),
            created_at: stored.created_at,
        };
        let mut keys = self.keys.lock().expect("lock");
        keys.push(stored);
        self.save(&keys)?;
        Ok(info)
    }

    /// Step 1 of sign-in. Any registered passkey may answer.
    pub fn start_authentication(&self) -> Result<(String, RequestChallengeResponse), PasskeyError> {
        let creds: Vec<Passkey> =
            self.keys.lock().expect("lock").iter().map(|k| k.passkey.clone()).collect();
        if creds.is_empty() {
            return Err(PasskeyError("no passkeys registered".into()));
        }
        let (rcr, state) = self.webauthn.start_passkey_authentication(&creds)?;
        let id = random_id();
        let mut pending = self.pending_auth.lock().expect("lock");
        pending.retain(|_, (t, _)| t.elapsed() < CHALLENGE_TTL);
        pending.insert(id.clone(), (Instant::now(), state));
        Ok((id, rcr))
    }

    /// Step 2 of sign-in. Ok means the assertion verified against a stored passkey.
    pub fn finish_authentication(
        &self,
        challenge_id: &str,
        credential: &PublicKeyCredential,
    ) -> Result<PasskeyInfo, PasskeyError> {
        let (started, state) = self
            .pending_auth
            .lock()
            .expect("lock")
            .remove(challenge_id)
            .ok_or_else(|| PasskeyError("unknown or expired challenge".into()))?;
        if started.elapsed() > CHALLENGE_TTL {
            return Err(PasskeyError("challenge expired".into()));
        }
        let result = self.webauthn.finish_passkey_authentication(credential, &state)?;

        let mut keys = self.keys.lock().expect("lock");
        let key = keys
            .iter_mut()
            .find(|k| k.passkey.cred_id() == result.cred_id())
            .ok_or_else(|| PasskeyError("unknown credential".into()))?;
        // Keeps the signature counter and backup state current.
        if key.passkey.update_credential(&result) == Some(true) {
            let info = PasskeyInfo {
                id: key.id.clone(),
                name: key.name.clone(),
                created_at: key.created_at,
            };
            self.save(&keys)?;
            return Ok(info);
        }
        Ok(PasskeyInfo { id: key.id.clone(), name: key.name.clone(), created_at: key.created_at })
    }
}

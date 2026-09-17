//! Password sign-in with a stateless, HMAC-signed session cookie.
//!
//! There is no user store: one wallet, one password (`WALLET_PASSWORD`). A
//! session is a cookie containing an expiry signed with a server-side key, so
//! there is nothing to persist.
//!
//! Why a **cookie** rather than an `Authorization` header: `/api/events` is
//! consumed from the browser with `EventSource`, which cannot set custom headers.
//! A cookie authenticates both `fetch` and SSE. It's `HttpOnly` so that a script
//! injection can't read the session out of the page.
//!
//! Flow:
//!   POST /api/auth/login   { password }  -> set cookie, { ok: true } or 401
//!   GET  /api/auth/me                    -> { auth_enabled, logged_in, has_passkeys }
//!   POST /api/auth/logout                -> clear cookie
//!
//! Passkeys (WebAuthn), see `passkeys.rs`:
//!   POST /api/auth/passkey/login/start      (public)  -> { challenge_id, options }
//!   POST /api/auth/passkey/login/finish     (public)  { challenge_id, credential } -> set cookie
//!   GET  /api/auth/passkeys                 (session) -> [{ id, name, created_at }]
//!   POST /api/auth/passkey/register/start   (session) -> { challenge_id, options }
//!   POST /api/auth/passkey/register/finish  (session) { challenge_id, name, credential }
//!   POST /api/auth/passkey/delete           (session) { id }

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;

use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};

use crate::config::{Auth, PasswordAuth};
use crate::passkeys::PasskeyError;

type HmacSha256 = Hmac<Sha256>;

const SESSION_COOKIE: &str = "mutiny_session";

// ---- Session token ---------------------------------------------------------
//
// Format: `v1.<payload_b64url>.<sig_b64url>` where payload is
// `{"e": expiry_unix}` and sig = HMAC-SHA256(secret, "v1.<payload>").

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn sign(secret: &[u8], msg: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(msg.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn issue_session(cfg: &PasswordAuth) -> String {
    let payload = json!({ "e": now_unix() + cfg.session_ttl.as_secs() });
    let body = format!("v1.{}", URL_SAFE_NO_PAD.encode(payload.to_string()));
    let sig = sign(&cfg.session_secret, &body);
    format!("{body}.{sig}")
}

/// True iff the signature is valid and the token has not expired.
fn verify_session(cfg: &PasswordAuth, token: &str) -> bool {
    let Some((body, sig)) = token.rsplit_once('.') else { return false };
    let Some((version, payload_b64)) = body.split_once('.') else { return false };
    if version != "v1" {
        return false;
    }

    // Constant-time compare: `verify_slice` is what makes this safe against a
    // timing oracle, so don't "simplify" it into a `==` on the signatures.
    let Ok(mut mac) = HmacSha256::new_from_slice(&cfg.session_secret) else { return false };
    mac.update(body.as_bytes());
    let Ok(sig) = URL_SAFE_NO_PAD.decode(sig) else { return false };
    if mac.verify_slice(&sig).is_err() {
        return false;
    }

    let Ok(payload) = URL_SAFE_NO_PAD.decode(payload_b64) else { return false };
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&payload) else { return false };
    payload.get("e").and_then(|e| e.as_u64()).map(|e| e > now_unix()).unwrap_or(false)
}

/// Constant-time password check: compare HMACs of both sides so the comparison
/// does not leak the length or the position of the first mismatch.
fn password_matches(cfg: &PasswordAuth, given: &str) -> bool {
    let mut expected = HmacSha256::new_from_slice(&cfg.session_secret).expect("any key length");
    expected.update(cfg.password.as_bytes());
    let expected = expected.finalize().into_bytes();

    let mut mac = HmacSha256::new_from_slice(&cfg.session_secret).expect("any key length");
    mac.update(given.as_bytes());
    mac.verify_slice(&expected).is_ok()
}

fn session_cookie<'a>(cfg: &PasswordAuth, value: String, max_age: Duration) -> Cookie<'a> {
    Cookie::build((SESSION_COOKIE, value))
        .path("/")
        .http_only(true)
        .secure(cfg.secure_cookies())
        // Lax still blocks cross-site POSTs to the spending RPCs.
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(max_age.as_secs() as i64))
        .build()
}

// ---- Middleware ------------------------------------------------------------

/// Rejects any request without a valid session. Applied to every `/api` route
/// except the auth endpoints and `/api/health`.
pub async fn require_auth(
    State(auth): State<Arc<Auth>>,
    jar: CookieJar,
    req: Request,
    next: Next,
) -> Response {
    let cfg = match auth.as_ref() {
        Auth::Disabled => return next.run(req).await,
        Auth::Password(cfg) => cfg,
    };

    let ok = jar.get(SESSION_COOKIE).map(|c| verify_session(cfg, c.value())).unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "code": "Unauthenticated", "message": "sign in required" })),
        )
            .into_response()
    }
}

// ---- Handlers --------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginBody {
    password: String,
}

pub async fn login(
    State(auth): State<Arc<Auth>>,
    jar: CookieJar,
    Json(body): Json<LoginBody>,
) -> Response {
    let cfg = match auth.as_ref() {
        Auth::Disabled => return Json(json!({ "ok": true })).into_response(),
        Auth::Password(cfg) => cfg,
    };

    if !password_matches(cfg, &body.password) {
        // Slow down online guessing. One wallet, one password: a fixed delay is
        // enough to make brute force impractical without a lockout table.
        tokio::time::sleep(Duration::from_secs(2)).await;
        tracing::warn!("rejected sign-in: wrong password");
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "code": "Unauthenticated", "message": "wrong password" })),
        )
            .into_response();
    }

    tracing::info!("signed in");
    let jar = jar.add(session_cookie(cfg, issue_session(cfg), cfg.session_ttl));
    (jar, Json(json!({ "ok": true }))).into_response()
}

/// Am I signed in? Drives the web app's sign-in gate.
pub async fn me(State(auth): State<Arc<Auth>>, jar: CookieJar) -> Response {
    match auth.as_ref() {
        // With auth off the UI shouldn't render a sign-in gate at all.
        Auth::Disabled => {
            Json(json!({ "auth_enabled": false, "logged_in": true, "has_passkeys": false }))
                .into_response()
        }
        Auth::Password(cfg) => {
            let ok =
                jar.get(SESSION_COOKIE).map(|c| verify_session(cfg, c.value())).unwrap_or(false);
            let body = json!({
                "auth_enabled": true,
                "logged_in": ok,
                "has_passkeys": cfg.passkeys.has_any()
            });
            if ok {
                Json(body).into_response()
            } else {
                (StatusCode::UNAUTHORIZED, Json(body)).into_response()
            }
        }
    }
}

// ---- Passkeys --------------------------------------------------------------

fn passkey_err(e: PasskeyError) -> Response {
    tracing::warn!("passkey: {}", e.0);
    (StatusCode::BAD_REQUEST, Json(json!({ "code": "PasskeyError", "message": e.0 })))
        .into_response()
}

fn auth_disabled() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "code": "AuthDisabled", "message": "authentication is off" })),
    )
        .into_response()
}

pub async fn passkey_list(State(auth): State<Arc<Auth>>) -> Response {
    match auth.as_ref() {
        Auth::Disabled => Json(json!([])).into_response(),
        Auth::Password(cfg) => Json(cfg.passkeys.list()).into_response(),
    }
}

pub async fn passkey_register_start(State(auth): State<Arc<Auth>>) -> Response {
    let Auth::Password(cfg) = auth.as_ref() else { return auth_disabled() };
    match cfg.passkeys.start_registration() {
        Ok((challenge_id, options)) => {
            Json(json!({ "challenge_id": challenge_id, "options": options })).into_response()
        }
        Err(e) => passkey_err(e),
    }
}

#[derive(Deserialize)]
pub struct RegisterFinishBody {
    challenge_id: String,
    #[serde(default)]
    name: String,
    credential: RegisterPublicKeyCredential,
}

pub async fn passkey_register_finish(
    State(auth): State<Arc<Auth>>,
    Json(body): Json<RegisterFinishBody>,
) -> Response {
    let Auth::Password(cfg) = auth.as_ref() else { return auth_disabled() };
    match cfg.passkeys.finish_registration(&body.challenge_id, &body.name, &body.credential) {
        Ok(info) => {
            tracing::info!("registered passkey `{}`", info.name);
            Json(info).into_response()
        }
        Err(e) => passkey_err(e),
    }
}

#[derive(Deserialize)]
pub struct DeleteBody {
    id: String,
}

pub async fn passkey_delete(
    State(auth): State<Arc<Auth>>,
    Json(body): Json<DeleteBody>,
) -> Response {
    let Auth::Password(cfg) = auth.as_ref() else { return auth_disabled() };
    match cfg.passkeys.delete(&body.id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => passkey_err(e),
    }
}

pub async fn passkey_login_start(State(auth): State<Arc<Auth>>) -> Response {
    let Auth::Password(cfg) = auth.as_ref() else { return auth_disabled() };
    match cfg.passkeys.start_authentication() {
        Ok((challenge_id, options)) => {
            Json(json!({ "challenge_id": challenge_id, "options": options })).into_response()
        }
        Err(e) => passkey_err(e),
    }
}

#[derive(Deserialize)]
pub struct LoginFinishBody {
    challenge_id: String,
    credential: PublicKeyCredential,
}

pub async fn passkey_login_finish(
    State(auth): State<Arc<Auth>>,
    jar: CookieJar,
    Json(body): Json<LoginFinishBody>,
) -> Response {
    let Auth::Password(cfg) = auth.as_ref() else { return auth_disabled() };
    match cfg.passkeys.finish_authentication(&body.challenge_id, &body.credential) {
        Ok(info) => {
            tracing::info!("signed in with passkey `{}`", info.name);
            let jar = jar.add(session_cookie(cfg, issue_session(cfg), cfg.session_ttl));
            (jar, Json(json!({ "ok": true }))).into_response()
        }
        Err(e) => {
            tracing::warn!("rejected passkey sign-in: {}", e.0);
            (StatusCode::UNAUTHORIZED, Json(json!({ "code": "Unauthenticated", "message": e.0 })))
                .into_response()
        }
    }
}

pub async fn logout(State(auth): State<Arc<Auth>>, jar: CookieJar) -> Response {
    let jar = match auth.as_ref() {
        Auth::Disabled => jar,
        // Overwrite with an already-expired cookie rather than only removing it,
        // so the browser drops it even if the removal cookie's attributes differ.
        Auth::Password(cfg) => jar.add(session_cookie(cfg, String::new(), Duration::ZERO)),
    };
    (jar, Json(json!({ "ok": true }))).into_response()
}

//! Lightning Address (LUD-16) over LNURL-pay (LUD-06), with LUD-21 verify so a
//! payer like Zaprite can confirm settlement.
//!
//!   GET /.well-known/lnurlp/<username>        pay request
//!   GET /lnurlp/<username>/callback?amount=   BOLT11 invoice for `amount` msat
//!   GET /lnurlp/verify/<payment_hash>         { settled, preimage, pr }
//!
//! These routes are public by design: anyone may ask for an invoice to pay us.
//! They can only create invoices and report on ones we issued.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::invoices::{self, Description, Invoices, State as InvoiceState};

const MIN_SENDABLE_MSAT: u64 = 1_000;
const MAX_SENDABLE_MSAT: u64 = 100_000_000_000;

pub struct Settings {
    username: String,
    public_url: String,
    domain: String,
}

impl Settings {
    /// `public_url` is the externally-visible origin, without a trailing slash.
    pub fn new(username: &str, public_url: &str) -> anyhow::Result<Self> {
        let username = username.trim().to_ascii_lowercase();
        // LUD-16 local parts are limited to this alphabet.
        if username.is_empty()
            || !username.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        {
            anyhow::bail!("WALLET_LNURL_USERNAME may only use a-z, 0-9, '-', '_' and '.'");
        }
        let url = url::Url::parse(public_url)
            .map_err(|e| anyhow::anyhow!("WALLET_PUBLIC_URL is not a URL ({e})"))?;
        let domain = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("WALLET_PUBLIC_URL has no host"))?
            .to_string();
        Ok(Self { username, public_url: public_url.to_string(), domain })
    }

    pub fn lightning_address(&self) -> String {
        format!("{}@{}", self.username, self.domain)
    }

    /// The LUD-06 metadata. The invoice commits to its SHA-256.
    fn metadata(&self) -> String {
        let address = self.lightning_address();
        json!([["text/plain", format!("Pay {address}")], ["text/identifier", address]]).to_string()
    }
}

#[derive(Clone)]
struct Lnurl {
    settings: Arc<Settings>,
    invoices: Arc<Invoices>,
}

pub fn router(settings: Settings, invoices: Arc<Invoices>) -> Router {
    Router::new()
        .route("/.well-known/lnurlp/:username", get(pay_request))
        .route("/lnurlp/:username/callback", get(callback))
        .route("/lnurlp/verify/:payment_hash", get(verify))
        .with_state(Lnurl { settings: Arc::new(settings), invoices })
}

async fn pay_request(State(lnurl): State<Lnurl>, Path(username): Path<String>) -> Response {
    let settings = &lnurl.settings;
    if username.to_ascii_lowercase() != settings.username {
        return error(StatusCode::NOT_FOUND, "Unknown user");
    }
    Json(json!({
        "tag": "payRequest",
        "callback": format!("{}/lnurlp/{}/callback", settings.public_url, settings.username),
        "minSendable": MIN_SENDABLE_MSAT,
        "maxSendable": MAX_SENDABLE_MSAT,
        "metadata": settings.metadata(),
    }))
    .into_response()
}

async fn callback(
    State(lnurl): State<Lnurl>,
    Path(username): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let settings = &lnurl.settings;
    if username.to_ascii_lowercase() != settings.username {
        return error(StatusCode::NOT_FOUND, "Unknown user");
    }
    let Some(amount) = params.get("amount").and_then(|a| a.parse::<u64>().ok()) else {
        return error(StatusCode::BAD_REQUEST, "Missing amount in millisatoshis");
    };
    if !(MIN_SENDABLE_MSAT..=MAX_SENDABLE_MSAT).contains(&amount) {
        return error(StatusCode::BAD_REQUEST, "Amount out of range");
    }

    let description_hash: String =
        Sha256::digest(settings.metadata().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let issued = match lnurl
        .invoices
        .create(amount, Description::Hash(description_hash), invoices::DEFAULT_EXPIRY_SECS)
        .await
    {
        Ok(issued) => issued,
        Err(e) => {
            tracing::warn!("lnurl: creating invoice failed: {e}");
            return error(StatusCode::BAD_GATEWAY, "Could not create an invoice");
        }
    };
    Json(json!({
        "pr": issued.bolt11,
        "routes": [],
        "verify": format!("{}/lnurlp/verify/{}", settings.public_url, issued.payment_hash),
    }))
    .into_response()
}

async fn verify(State(lnurl): State<Lnurl>, Path(payment_hash): Path<String>) -> Response {
    match lnurl.invoices.lookup(&payment_hash).await {
        Ok(Some(invoice)) if invoice.incoming => Json(json!({
            "status": "OK",
            "settled": invoice.state == InvoiceState::Settled,
            "preimage": invoice.preimage,
            "pr": invoice.issued.map(|i| i.bolt11),
        }))
        .into_response(),
        Ok(_) => error(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => {
            tracing::warn!("lnurl: verify {payment_hash} failed: {e}");
            error(StatusCode::BAD_GATEWAY, "Could not look up the invoice")
        }
    }
}

fn error(status: StatusCode, reason: &str) -> Response {
    (status, Json(json!({ "status": "ERROR", "reason": reason }))).into_response()
}

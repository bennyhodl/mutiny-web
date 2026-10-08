//! End to end: the real sidecar binary in front of a real ldk-server, paid by a
//! second node over a real channel, driven the way Zaprite drives it.
//!
//! Zaprite takes payments two ways: Lightning Address today, Nostr Wallet
//! Connect next. Both must hand out an invoice, let the payer pay it, and then
//! prove settlement with a preimage. The NWC side must also refuse to spend.

use std::pin::Pin;
use std::process::{Child, Command};
use std::time::Duration;

use e2e_tests::{find_available_port, setup_funded_channel, LdkServerHandle, TestBitcoind};
use futures::{Stream, StreamExt};
use ldk_server_grpc::api::{Bolt11SendRequest, DecodeInvoiceRequest};
use nostr::nips::nip47::{
    ListTransactionsRequest, LookupInvoiceRequest, MakeInvoiceRequest, Method,
    NostrWalletConnectUri, Notification, NotificationResult, PayInvoiceRequest, TransactionState,
};
use nostr::prelude::*;
use nostr_sdk::client::{Client, ClientNotification};
use nostr_sdk::local_relay::LocalRelay;
use nwc::prelude::NostrWalletConnect;
use serde_json::Value;
use sha2::{Digest, Sha256};

const USERNAME: &str = "bitcoinbay";

#[tokio::test(flavor = "multi_thread")]
async fn zaprite_gets_paid_over_nwc_and_lightning_address() {
    let bitcoind = TestBitcoind::new();
    let payer = LdkServerHandle::start(&bitcoind).await;
    let merchant = LdkServerHandle::start(&bitcoind).await;
    setup_funded_channel(&bitcoind, &payer, &merchant, 1_000_000).await;

    let relay = LocalRelay::new();
    relay.run().await.unwrap();
    let relay_url = relay.url().await;

    let sidecar = Sidecar::start(&merchant, &relay_url).await;
    let connections = sidecar.get("/api/connections").await;

    let lightning_address = connections["lightning_address"].as_str().unwrap();
    assert_eq!(lightning_address, format!("{USERNAME}@127.0.0.1"));

    let uri = NostrWalletConnectUri::parse(connections["nwc"]["uri"].as_str().unwrap()).unwrap();
    assert_eq!(uri.relays, vec![relay_url.clone()]);
    assert_eq!(uri.lud16.as_deref(), Some(lightning_address));

    // Zaprite's NWC client may speak either cipher, so both must work end to end.
    let nip44 = NostrWalletConnect::new(uri.clone());
    let nip04 = NostrWalletConnect::builder(uri.clone()).force_nip04().build();
    for (wallet, cipher) in [(&nip44, "nip44_v2"), (&nip04, "nip04")] {
        receive_over_nwc(wallet, &uri, &payer, cipher).await;
    }

    receive_over_lightning_address(&sidecar, &payer).await;
}

async fn receive_over_nwc(
    wallet: &NostrWalletConnect,
    uri: &NostrWalletConnectUri,
    payer: &LdkServerHandle,
    cipher: &str,
) {
    let info = wallet.get_info().await.unwrap();
    assert_eq!(
        info.methods,
        vec![Method::GetInfo, Method::MakeInvoice, Method::LookupInvoice, Method::ListTransactions],
        "{cipher}"
    );
    assert_eq!(info.notifications, vec!["payment_received".to_string()], "{cipher}");
    assert_eq!(info.network.as_deref(), Some("regtest"), "{cipher}");

    let mut notifications = NotificationListener::start(uri).await;

    let made = wallet
        .make_invoice(MakeInvoiceRequest {
            amount: 21_000,
            description: Some(format!("Zaprite order over {cipher}")),
            description_hash: None,
            expiry: None,
        })
        .await
        .unwrap();
    let payment_hash = made.payment_hash.clone().unwrap();
    assert_eq!(made.amount, Some(21_000), "{cipher}");

    let unpaid = wallet
        .lookup_invoice(LookupInvoiceRequest {
            payment_hash: Some(payment_hash.clone()),
            invoice: None,
        })
        .await
        .unwrap();
    assert_eq!(unpaid.state, Some(TransactionState::Pending), "{cipher}");
    assert_eq!(unpaid.preimage, None, "an unpaid invoice must not reveal its preimage");

    payer
        .client()
        .bolt11_send(Bolt11SendRequest {
            invoice: made.invoice.clone(),
            amount_msat: None,
            route_parameters: None,
        })
        .await
        .unwrap();

    // The wallet announces the payment in both ciphers.
    let received = notifications.payment_received(&payment_hash).await;
    for notification in &received {
        assert_eq!(notification.invoice, made.invoice, "{cipher}");
        assert_eq!(notification.amount, 21_000, "{cipher}");
        assert_eq!(notification.state, Some(TransactionState::Settled), "{cipher}");
        assert_preimage_matches(&notification.preimage, &payment_hash);
    }

    // Looking up by the invoice string works as well as by hash.
    let paid = wallet
        .lookup_invoice(LookupInvoiceRequest { payment_hash: None, invoice: Some(made.invoice) })
        .await
        .unwrap();
    assert_eq!(paid.state, Some(TransactionState::Settled), "{cipher}");
    assert_eq!(paid.payment_hash, payment_hash, "{cipher}");
    assert_preimage_matches(paid.preimage.as_deref().unwrap(), &payment_hash);
    assert!(paid.settled_at.is_some(), "{cipher}");

    let history = wallet.list_transactions(ListTransactionsRequest::default()).await.unwrap();
    assert!(history.iter().any(|t| t.payment_hash == payment_hash), "{cipher}");

    // The connection can never spend, whatever it asks for.
    let invoice = payer
        .client()
        .bolt11_receive(ldk_server_grpc::api::Bolt11ReceiveRequest {
            amount_msat: Some(1_000),
            description: None,
            expiry_secs: 600,
        })
        .await
        .unwrap()
        .invoice;
    let refused = wallet.pay_invoice(PayInvoiceRequest::new(invoice)).await.unwrap_err();
    assert!(refused.to_string().contains("Restricted"), "{cipher}: {refused}");
}

async fn receive_over_lightning_address(sidecar: &Sidecar, payer: &LdkServerHandle) {
    let pay_request = sidecar.get(&format!("/.well-known/lnurlp/{USERNAME}")).await;
    assert_eq!(pay_request["tag"], "payRequest");
    let metadata = pay_request["metadata"].as_str().unwrap();
    let callback = pay_request["callback"].as_str().unwrap();

    let invoice = get_json(&format!("{callback}?amount=50000")).await;
    let pr = invoice["pr"].as_str().unwrap();
    let verify_url = invoice["verify"].as_str().unwrap();

    // The invoice commits to the metadata, as LUD-06 requires.
    let decoded = payer
        .client()
        .decode_invoice(DecodeInvoiceRequest { invoice: pr.to_string() })
        .await
        .unwrap();
    assert_eq!(decoded.amount_msat, Some(50_000));
    assert_eq!(decoded.description_hash.as_deref(), Some(hex(&Sha256::digest(metadata)).as_str()));

    let unpaid = get_json(verify_url).await;
    assert_eq!(unpaid["settled"], false);
    assert_eq!(unpaid["preimage"], Value::Null);

    payer
        .client()
        .bolt11_send(Bolt11SendRequest {
            invoice: pr.to_string(),
            amount_msat: None,
            route_parameters: None,
        })
        .await
        .unwrap();

    let paid = poll(|| async {
        let v = get_json(verify_url).await;
        (v["settled"] == true).then_some(v)
    })
    .await;
    assert_eq!(paid["pr"], pr);
    assert_preimage_matches(paid["preimage"].as_str().unwrap(), &decoded.payment_hash);

    // Out-of-range amounts and unknown users are refused in LNURL's error shape.
    let too_small = reqwest::get(format!("{callback}?amount=1")).await.unwrap();
    assert_eq!(too_small.status(), 400);
    assert_eq!(too_small.json::<Value>().await.unwrap()["status"], "ERROR");
    let unknown = reqwest::get(format!("{}/.well-known/lnurlp/nobody", sidecar.url)).await.unwrap();
    assert_eq!(unknown.status(), 404);
}

/// The sidecar binary, configured purely through env like production.
struct Sidecar {
    child: Child,
    url: String,
}

impl Sidecar {
    async fn start(node: &LdkServerHandle, relay: &RelayUrl) -> Self {
        let port = find_available_port();
        let url = format!("http://127.0.0.1:{port}");
        let child = Command::new(env!("CARGO_BIN_EXE_mutiny-sidecar"))
            .env_clear()
            .env("RUST_LOG", "info")
            .env("WALLET_AUTH", "off")
            .env("LDK_CONFIG", &node.config_path)
            .env("PORT", port.to_string())
            .env("WALLET_PUBLIC_URL", &url)
            .env("WALLET_NWC_RELAY", relay.to_string())
            .env("WALLET_LNURL_USERNAME", USERNAME)
            .spawn()
            .unwrap();
        let sidecar = Self { child, url };
        poll(|| async {
            reqwest::get(format!("{}/api/health", sidecar.url))
                .await
                .ok()
                .filter(|r| r.status().is_success())
        })
        .await;
        sidecar
    }

    async fn get(&self, path: &str) -> Value {
        get_json(&format!("{}{path}", self.url)).await
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Reads NWC notifications straight off the relay, as an app would. The stream
/// is opened before subscribing so nothing published after `start` is missed.
struct NotificationListener {
    _client: Client,
    events: Pin<Box<dyn Stream<Item = ClientNotification> + Send>>,
    uri: NostrWalletConnectUri,
}

impl NotificationListener {
    async fn start(uri: &NostrWalletConnectUri) -> Self {
        let client = Client::new();
        client.add_relay(&uri.relays[0]).await.unwrap();
        client.connect().and_wait(Duration::from_secs(5)).await;
        let events = client.notifications();
        client
            .subscribe(
                Filter::new()
                    .author(uri.public_key)
                    .pubkey(Keys::new(uri.secret.clone()).public_key())
                    .kinds([
                        Kind::WalletConnectNotification,
                        Kind::WalletConnectNotificationNip44V2,
                    ])
                    .since(Timestamp::now()),
            )
            .await
            .unwrap();
        Self { _client: client, events, uri: uri.clone() }
    }

    /// Wait for `payment_received` for this hash in both the nip44 and nip04 kinds.
    async fn payment_received(
        &mut self,
        payment_hash: &str,
    ) -> Vec<nostr::nips::nip47::PaymentNotification> {
        let (events, uri) = (&mut self.events, &self.uri);
        let mut by_kind = std::collections::HashMap::new();
        tokio::time::timeout(Duration::from_secs(60), async {
            while by_kind.len() < 2 {
                let Some(ClientNotification::Event { event, .. }) = events.next().await else {
                    continue;
                };
                let notification = Notification::from_event(uri, &event).unwrap();
                if let NotificationResult::PaymentReceived(p) = notification.notification {
                    if p.payment_hash == payment_hash {
                        by_kind.insert(event.kind, p);
                    }
                }
            }
        })
        .await
        .expect("payment_received in both ciphers");
        by_kind.into_values().collect()
    }
}

async fn get_json(url: &str) -> Value {
    let response = reqwest::get(url).await.unwrap();
    assert!(response.status().is_success(), "GET {url}: {}", response.status());
    response.json().await.unwrap()
}

async fn poll<T, F, Fut>(mut attempt: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(value) = attempt().await {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .expect("timed out")
}

fn assert_preimage_matches(preimage: &str, payment_hash: &str) {
    let bytes: Vec<u8> = (0..preimage.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&preimage[i..i + 2], 16).unwrap())
        .collect();
    assert_eq!(
        hex(&Sha256::digest(bytes)),
        payment_hash,
        "preimage does not hash to the payment hash"
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

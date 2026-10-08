//! Nostr Wallet Connect (NIP-47) wallet service. Receive-only.
//!
//! One connection, whose keys are derived from ldk-server's own mnemonic, so
//! there is nothing new to back up. It can create invoices and report on
//! payments; it can never spend. Every method that moves funds answers
//! `RESTRICTED`.
//!
//! Key derivation follows NIP-06 (`m/44'/1237'/<account>'/<type>/<index>`) on a
//! dedicated account, so it can't collide with a Nostr identity someone derived
//! from the same mnemonic:
//!
//!   wallet service key  m/44'/1237'/47'/0/0
//!   connection key      m/44'/1237'/47'/1/<connection>
//!
//! Bumping `<connection>` (WALLET_NWC_CONNECTION) revokes the old connection
//! string and issues a new one.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use ldk_server_client::client::LdkServerClient;
use ldk_server_grpc::api::GetNodeInfoRequest;
use ldk_server_grpc::events::event_envelope;
use ldk_server_grpc::types::Network;
use nostr::nips::nip47::{
    ErrorCode, GetInfoResponse, ListTransactionsRequest, LookupInvoiceRequest,
    LookupInvoiceResponse, MakeInvoiceRequest, MakeInvoiceResponse, Method, NIP47Error,
    Nip47Ciphers, Nip47Tag, NostrWalletConnectUri, Notification, NotificationResult,
    NotificationType, PaymentNotification, Request, RequestParams, Response, ResponseResult,
    TransactionState, TransactionType,
};
use nostr::prelude::*;
use nostr_sdk::client::{Client, ClientNotification};
use serde_json::Value;

use crate::invoices::{self, Description, Invoice, Invoices, State};

const ACCOUNT: u32 = 47;
const WALLET_KEY_TYPE: u32 = 0;
const CONNECTION_KEY_TYPE: u32 = 1;

/// Both ciphers, newest first. We answer in whichever one the request used.
const CIPHERS: Nip47Ciphers = Nip47Ciphers::NIP44V2.add(Nip47Ciphers::NIP04);

fn methods() -> Vec<Method> {
    vec![Method::GetInfo, Method::MakeInvoice, Method::LookupInvoice, Method::ListTransactions]
}

const NOTIFICATIONS: &str = "payment_received";

pub struct Settings {
    relay: RelayUrl,
    wallet: Keys,
    connection: Keys,
}

impl Settings {
    pub fn from_mnemonic(relay: RelayUrl, mnemonic: &str, connection: u32) -> anyhow::Result<Self> {
        let derive = |r#type, index| {
            Keys::from_mnemonic_advanced(
                mnemonic.trim(),
                None,
                Some(ACCOUNT),
                Some(r#type),
                Some(index),
            )
        };
        Ok(Self {
            relay,
            wallet: derive(WALLET_KEY_TYPE, 0)?,
            connection: derive(CONNECTION_KEY_TYPE, connection)?,
        })
    }
}

pub struct Nwc {
    settings: Settings,
    lightning_address: Option<String>,
}

impl Nwc {
    pub fn new(settings: Settings, lightning_address: Option<String>) -> Self {
        Self { settings, lightning_address }
    }

    /// The connection string to paste into the app (Zaprite).
    pub fn uri(&self) -> NostrWalletConnectUri {
        NostrWalletConnectUri::new(
            self.settings.wallet.public_key(),
            vec![self.settings.relay.clone()],
            self.settings.connection.secret_key().clone(),
            self.lightning_address.clone(),
        )
    }

    pub fn relay(&self) -> &RelayUrl {
        &self.settings.relay
    }

    pub fn method_names() -> Vec<String> {
        methods().iter().map(|m| m.to_string()).collect()
    }

    /// Serve requests and publish payment notifications until the process exits.
    pub fn spawn(self: Arc<Self>, invoices: Arc<Invoices>, ldk: Arc<LdkServerClient>) {
        tokio::spawn(async move {
            if let Err(e) = self.run(invoices, ldk).await {
                tracing::error!("nwc stopped: {e:#}");
            }
        });
    }

    async fn run(
        self: Arc<Self>,
        invoices: Arc<Invoices>,
        ldk: Arc<LdkServerClient>,
    ) -> anyhow::Result<()> {
        let relay = Client::new();
        relay.add_relay(&self.settings.relay).await?;
        relay.connect().and_wait(Duration::from_secs(10)).await;

        if let Err(e) = relay.send_event(&self.info_event()?).await {
            tracing::warn!("nwc: publishing the info event failed: {e}");
        }
        relay
            .subscribe(
                Filter::new()
                    .kind(Kind::WalletConnectRequest)
                    .author(self.settings.connection.public_key())
                    .pubkey(self.settings.wallet.public_key())
                    .since(Timestamp::now()),
            )
            .await?;
        tracing::info!(
            "nwc: serving on {} as {}",
            self.settings.relay,
            self.settings.wallet.public_key()
        );

        tokio::spawn(self.clone().notify_payments(relay.clone(), invoices.clone(), ldk.clone()));

        let mut events = relay.notifications();
        while let Some(notification) = events.next().await {
            match notification {
                ClientNotification::Event { event, .. } => {
                    let (this, relay, invoices, ldk) =
                        (self.clone(), relay.clone(), invoices.clone(), ldk.clone());
                    tokio::spawn(async move {
                        match this.respond(&event, &invoices, &ldk).await {
                            Ok(Some(response)) => {
                                if let Err(e) = relay.send_event(&response).await {
                                    tracing::warn!("nwc: sending response failed: {e}");
                                }
                            }
                            Ok(None) => {}
                            Err(e) => tracing::warn!("nwc: dropped request {}: {e:#}", event.id),
                        }
                    });
                }
                ClientNotification::Shutdown => break,
                ClientNotification::Message { .. } => {}
            }
        }
        Ok(())
    }

    fn info_event(&self) -> anyhow::Result<Event> {
        Ok(EventBuilder::new(Kind::WalletConnectInfo, Self::method_names().join(" "))
            .tag(Nip47Tag::Encryption(CIPHERS))
            .tag(Tag::custom("notifications", [NOTIFICATIONS]))
            .finalize(&self.settings.wallet)?)
    }

    /// Decrypt, authorize, and answer one request. `None` means: not ours to answer.
    async fn respond(
        &self,
        event: &Event,
        invoices: &Invoices,
        ldk: &LdkServerClient,
    ) -> anyhow::Result<Option<Event>> {
        if event.pubkey != self.settings.connection.public_key()
            || event.verify().is_err()
            || event.is_expired()
        {
            return Ok(None);
        }

        let cipher = request_cipher(event);
        let plaintext =
            cipher.decrypt(self.settings.wallet.secret_key(), &event.pubkey, &event.content)?;
        let request: Value = serde_json::from_str(&plaintext)?;
        let method = Method::from_str(request["method"].as_str().unwrap_or_default())?;

        let response = if !methods().contains(&method) {
            let code = match method {
                Method::Unknown(_) => ErrorCode::NotImplemented,
                _ => ErrorCode::Restricted,
            };
            failure(method, code, "This connection can only receive.")
        } else {
            let request = Request::from_value(request)?;
            self.handle(request, invoices, ldk).await
        };

        let content = cipher.encrypt(
            self.settings.wallet.secret_key(),
            &event.pubkey,
            &response.as_json(),
        )?;
        let encryption =
            (cipher == Nip47Ciphers::NIP44V2).then(|| Tag::from(Nip47Tag::Encryption(cipher)));
        Ok(Some(
            EventBuilder::new(Kind::WalletConnectResponse, content)
                .tag(Tag::public_key(event.pubkey))
                .tag(Tag::event(event.id))
                .tag_maybe(encryption)
                .finalize(&self.settings.wallet)?,
        ))
    }

    async fn handle(
        &self,
        request: Request,
        invoices: &Invoices,
        ldk: &LdkServerClient,
    ) -> Response {
        let method = request.method.clone();
        let result = match request.params {
            RequestParams::GetInfo => get_info(ldk).await.map(ResponseResult::GetInfo),
            RequestParams::MakeInvoice(params) => {
                make_invoice(invoices, params).await.map(ResponseResult::MakeInvoice)
            }
            RequestParams::LookupInvoice(params) => {
                lookup_invoice(invoices, params).await.map(ResponseResult::LookupInvoice)
            }
            RequestParams::ListTransactions(params) => {
                list_transactions(invoices, params).await.map(ResponseResult::ListTransactions)
            }
            _ => Err(NIP47Error {
                code: ErrorCode::Restricted,
                message: "This connection can only receive.".into(),
            }),
        };
        match result {
            Ok(result) => Response { result_type: method, error: None, result: Some(result) },
            Err(error) => Response { result_type: method, error: Some(error), result: None },
        }
    }

    /// Publish `payment_received` for every settled incoming payment, in both
    /// ciphers, as NIP-47 asks of wallets that support both.
    async fn notify_payments(
        self: Arc<Self>,
        relay: Client,
        invoices: Arc<Invoices>,
        ldk: Arc<LdkServerClient>,
    ) {
        loop {
            let mut stream = match ldk.subscribe_events().await {
                Ok(stream) => stream,
                Err(e) => {
                    tracing::warn!("nwc: subscribing to ldk-server events failed: {e}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            while let Some(Ok(envelope)) = stream.next_message().await {
                let Some(event_envelope::Event::PaymentReceived(received)) = envelope.event else {
                    continue;
                };
                let Some(payment_hash) = received.payment.as_ref().and_then(invoices::payment_hash)
                else {
                    continue;
                };
                if let Err(e) = self.notify(&relay, &invoices, &payment_hash).await {
                    tracing::warn!("nwc: notifying payment {payment_hash} failed: {e:#}");
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn notify(
        &self,
        relay: &Client,
        invoices: &Invoices,
        payment_hash: &str,
    ) -> anyhow::Result<()> {
        let Some(invoice) = invoices.lookup(payment_hash).await? else {
            return Ok(());
        };
        if !invoice.incoming || invoice.state != State::Settled {
            return Ok(());
        }
        let notification = Notification {
            notification_type: NotificationType::PaymentReceived,
            notification: NotificationResult::PaymentReceived(payment_notification(&invoice)),
        }
        .as_json();

        let to = self.settings.connection.public_key();
        for (cipher, kind) in [
            (Nip47Ciphers::NIP44V2, Kind::WalletConnectNotificationNip44V2),
            (Nip47Ciphers::NIP04, Kind::WalletConnectNotification),
        ] {
            let content = cipher.encrypt(self.settings.wallet.secret_key(), &to, &notification)?;
            let event = EventBuilder::new(kind, content)
                .tag(Tag::public_key(to))
                .finalize(&self.settings.wallet)?;
            relay.send_event(&event).await?;
        }
        Ok(())
    }
}

/// nip44_v2 when the request says so; NIP-47 defines a missing tag as nip04.
fn request_cipher(event: &Event) -> Nip47Ciphers {
    event
        .tags
        .iter()
        .find_map(|t| match Nip47Tag::try_from(t).ok()? {
            Nip47Tag::Encryption(c) => Some(c),
        })
        .filter(|c| c.has(Nip47Ciphers::NIP44V2))
        .map_or(Nip47Ciphers::NIP04, |_| Nip47Ciphers::NIP44V2)
}

fn failure(method: Method, code: ErrorCode, message: &str) -> Response {
    Response {
        result_type: method,
        error: Some(NIP47Error { code, message: message.into() }),
        result: None,
    }
}

fn internal(e: impl std::fmt::Display) -> NIP47Error {
    NIP47Error { code: ErrorCode::Internal, message: e.to_string() }
}

async fn get_info(ldk: &LdkServerClient) -> Result<GetInfoResponse, NIP47Error> {
    let info = ldk.get_node_info(GetNodeInfoRequest {}).await.map_err(internal)?;
    let network = match info.network() {
        Network::Bitcoin => "mainnet",
        Network::Testnet | Network::Testnet4 => "testnet",
        Network::Signet => "signet",
        Network::Regtest => "regtest",
    };
    let block = info.current_best_block;
    Ok(GetInfoResponse {
        alias: info.node_alias,
        color: None,
        pubkey: Some(info.node_id),
        network: Some(network.into()),
        block_height: block.as_ref().map(|b| b.height),
        block_hash: block.map(|b| b.block_hash),
        methods: methods(),
        notifications: vec![NOTIFICATIONS.into()],
    })
}

async fn make_invoice(
    invoices: &Invoices,
    params: MakeInvoiceRequest,
) -> Result<MakeInvoiceResponse, NIP47Error> {
    let description = match params.description_hash {
        Some(hash) => Description::Hash(hash),
        None => Description::Direct(params.description.unwrap_or_default()),
    };
    let expiry = params
        .expiry
        .map(|e| u32::try_from(e).unwrap_or(u32::MAX))
        .unwrap_or(invoices::DEFAULT_EXPIRY_SECS);
    let issued = invoices.create(params.amount, description, expiry).await.map_err(internal)?;
    let (description, description_hash) = split_description(&issued.description);
    Ok(MakeInvoiceResponse {
        invoice: issued.bolt11,
        payment_hash: Some(issued.payment_hash),
        description,
        description_hash,
        preimage: None,
        amount: Some(issued.amount_msat),
        created_at: Some(Timestamp::from_secs(issued.created_at)),
        expires_at: Some(Timestamp::from_secs(issued.expires_at)),
    })
}

async fn lookup_invoice(
    invoices: &Invoices,
    params: LookupInvoiceRequest,
) -> Result<LookupInvoiceResponse, NIP47Error> {
    let payment_hash = match (params.payment_hash, params.invoice) {
        (Some(hash), _) => hash,
        (None, Some(bolt11)) => invoices.payment_hash_of(&bolt11).await.map_err(internal)?,
        (None, None) => {
            return Err(NIP47Error {
                code: ErrorCode::Other,
                message: "Pass payment_hash or invoice.".into(),
            })
        }
    };
    match invoices.lookup(&payment_hash).await.map_err(internal)? {
        Some(invoice) => Ok(transaction(&invoice)),
        None => Err(NIP47Error { code: ErrorCode::NotFound, message: "Invoice not found.".into() }),
    }
}

async fn list_transactions(
    invoices: &Invoices,
    params: ListTransactionsRequest,
) -> Result<Vec<LookupInvoiceResponse>, NIP47Error> {
    let from = params.from.map_or(0, |t| t.as_secs());
    let until = params.until.map_or(u64::MAX, |t| t.as_secs());
    let mut found: Vec<Invoice> = invoices
        .list()
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|i| params.unpaid.unwrap_or(false) || i.state == State::Settled)
        .filter(|i| match params.transaction_type {
            Some(TransactionType::Incoming) => i.incoming,
            Some(TransactionType::Outgoing) => !i.incoming,
            None => true,
        })
        .filter(|i| (from..=until).contains(&i.created_at()))
        .collect();
    found.sort_by_key(|i| std::cmp::Reverse(i.created_at()));
    Ok(found
        .iter()
        .skip(params.offset.unwrap_or(0) as usize)
        .take(params.limit.map_or(usize::MAX, |l| l as usize))
        .map(transaction)
        .collect())
}

fn transaction(invoice: &Invoice) -> LookupInvoiceResponse {
    let (description, description_hash) =
        invoice.issued.as_ref().map_or((None, None), |i| split_description(&i.description));
    LookupInvoiceResponse {
        transaction_type: Some(direction(invoice)),
        state: Some(match invoice.state {
            State::Pending => TransactionState::Pending,
            State::Settled => TransactionState::Settled,
            State::Expired => TransactionState::Expired,
            State::Failed => TransactionState::Failed,
        }),
        invoice: invoice.issued.as_ref().map(|i| i.bolt11.clone()),
        description,
        description_hash,
        preimage: invoice.preimage.clone(),
        payment_hash: invoice.payment_hash.clone(),
        amount: invoice.amount_msat,
        fees_paid: invoice.fees_paid_msat,
        created_at: Timestamp::from_secs(invoice.created_at()),
        expires_at: invoice.issued.as_ref().map(|i| Timestamp::from_secs(i.expires_at)),
        settled_at: invoice.settled_at().map(Timestamp::from_secs),
        metadata: None,
    }
}

fn payment_notification(invoice: &Invoice) -> PaymentNotification {
    let tx = transaction(invoice);
    PaymentNotification {
        transaction_type: tx.transaction_type,
        state: tx.state,
        invoice: tx.invoice.unwrap_or_default(),
        description: tx.description,
        description_hash: tx.description_hash,
        preimage: tx.preimage.unwrap_or_default(),
        payment_hash: tx.payment_hash,
        amount: tx.amount,
        fees_paid: tx.fees_paid,
        created_at: tx.created_at,
        expires_at: tx.expires_at,
        settled_at: tx.settled_at.unwrap_or_else(|| Timestamp::from_secs(invoices::now())),
        metadata: None,
    }
}

fn direction(invoice: &Invoice) -> TransactionType {
    if invoice.incoming {
        TransactionType::Incoming
    } else {
        TransactionType::Outgoing
    }
}

fn split_description(description: &Description) -> (Option<String>, Option<String>) {
    match description {
        Description::Direct(d) => (Some(d.clone()), None),
        Description::Hash(h) => (None, Some(h.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                            abandon abandon abandon abandon abandon abandon abandon abandon \
                            abandon abandon abandon abandon abandon abandon abandon art";

    /// Paired apps hold these keys. If derivation ever changes, every existing
    /// connection silently breaks, so the exact keys are pinned here. The values
    /// were cross-checked with an independent BIP-32 derivation of these paths.
    #[test]
    fn keys_are_pinned_to_the_mnemonic() {
        let relay = RelayUrl::parse("wss://relay.example.com").unwrap();
        let first = Settings::from_mnemonic(relay.clone(), MNEMONIC, 0).unwrap();
        let rotated = Settings::from_mnemonic(relay, MNEMONIC, 1).unwrap();

        assert_eq!(
            first.wallet.public_key().to_hex(),
            "2086bb7d2a4bb8e1d50c187ca6c0edd3ff25905d2b370ffa6b26048fee981e8c"
        );
        assert_eq!(
            first.connection.public_key().to_hex(),
            "3f55aa08bf5c46cd0402103896169432e6ddcb3fb67a3c1d825424bf2d3edf5d"
        );

        // Rotating the connection keeps the wallet identity and changes the secret.
        assert_eq!(rotated.wallet.public_key(), first.wallet.public_key());
        assert_ne!(rotated.connection.public_key(), first.connection.public_key());
    }
}

//! Invoices this sidecar issues to outside payers (NWC and LNURL), and their state.
//!
//! ldk-server stores each payment by hash, but not the BOLT11 string or its
//! description, and both NIP-47 and LUD-21 hand those back to the payer. So
//! `Invoices` remembers what it issued, in memory, and joins that with
//! ldk-server's payment record. A restart forgets the issued details; the
//! settlement state still comes from ldk-server, so lookups keep working, just
//! without the invoice string.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ldk_server_client::client::LdkServerClient;
use ldk_server_client::error::LdkServerError;
use ldk_server_grpc::api::{
    Bolt11ReceiveRequest, DecodeInvoiceRequest, GetPaymentDetailsRequest, ListPaymentsRequest,
};
use ldk_server_grpc::types::{
    bolt11_invoice_description, payment_kind, Bolt11InvoiceDescription, Payment, PaymentDirection,
    PaymentStatus,
};

/// Expiry for invoices whose requester doesn't pick one.
pub const DEFAULT_EXPIRY_SECS: u32 = 3600;

/// How long an issued invoice is remembered after it expires, so a late
/// lookup still returns the invoice string.
const RETAIN_AFTER_EXPIRY_SECS: u64 = 7 * 24 * 3600;

#[derive(Clone, Debug)]
pub enum Description {
    Direct(String),
    /// Hex SHA-256 of the description, as LNURL requires.
    Hash(String),
}

/// An invoice as we handed it out.
#[derive(Clone, Debug)]
pub struct Issued {
    pub bolt11: String,
    pub payment_hash: String,
    pub description: Description,
    pub amount_msat: u64,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Settled,
    Expired,
    Failed,
}

/// One Lightning payment, joined with what we issued for it if we issued it.
#[derive(Clone, Debug)]
pub struct Invoice {
    pub payment_hash: String,
    pub issued: Option<Issued>,
    pub incoming: bool,
    pub state: State,
    /// Only present once settled. ldk-node knows the preimage of an inbound
    /// invoice from the start, and revealing it early would let anyone claim
    /// they paid.
    pub preimage: Option<String>,
    pub amount_msat: u64,
    pub fees_paid_msat: u64,
    pub updated_at: u64,
}

impl Invoice {
    pub fn created_at(&self) -> u64 {
        self.issued.as_ref().map_or(self.updated_at, |i| i.created_at)
    }

    pub fn settled_at(&self) -> Option<u64> {
        (self.state == State::Settled).then_some(self.updated_at)
    }
}

pub struct Invoices {
    client: Arc<LdkServerClient>,
    issued: Mutex<HashMap<String, Issued>>,
}

impl Invoices {
    pub fn new(client: Arc<LdkServerClient>) -> Self {
        Self { client, issued: Mutex::new(HashMap::new()) }
    }

    pub async fn create(
        &self,
        amount_msat: u64,
        description: Description,
        expiry_secs: u32,
    ) -> Result<Issued, LdkServerError> {
        let kind = match &description {
            Description::Direct(d) => bolt11_invoice_description::Kind::Direct(d.clone()),
            Description::Hash(h) => bolt11_invoice_description::Kind::Hash(h.clone()),
        };
        let response = self
            .client
            .bolt11_receive(Bolt11ReceiveRequest {
                amount_msat: Some(amount_msat),
                description: Some(Bolt11InvoiceDescription { kind: Some(kind) }),
                expiry_secs,
            })
            .await?;

        let created_at = now();
        let issued = Issued {
            bolt11: response.invoice,
            payment_hash: response.payment_hash,
            description,
            amount_msat,
            created_at,
            expires_at: created_at + u64::from(expiry_secs),
        };

        let mut book = self.issued.lock().unwrap();
        book.retain(|_, i| i.expires_at + RETAIN_AFTER_EXPIRY_SECS > created_at);
        book.insert(issued.payment_hash.clone(), issued.clone());
        Ok(issued)
    }

    /// Look up a payment by hash. ldk-node keys BOLT11 payments by their hash.
    pub async fn lookup(&self, payment_hash: &str) -> Result<Option<Invoice>, LdkServerError> {
        let response = self
            .client
            .get_payment_details(GetPaymentDetailsRequest { payment_id: payment_hash.to_string() })
            .await?;
        Ok(response.payment.and_then(|p| self.join(&p)))
    }

    /// Every Lightning payment the node knows, in ldk-server's order.
    pub async fn list(&self) -> Result<Vec<Invoice>, LdkServerError> {
        let mut invoices = Vec::new();
        let mut page_token = None;
        loop {
            let page = self.client.list_payments(ListPaymentsRequest { page_token }).await?;
            invoices.extend(page.payments.iter().filter_map(|p| self.join(p)));
            match page.next_page_token {
                Some(token) => page_token = Some(token),
                None => return Ok(invoices),
            }
        }
    }

    pub async fn payment_hash_of(&self, bolt11: &str) -> Result<String, LdkServerError> {
        let decoded = self
            .client
            .decode_invoice(DecodeInvoiceRequest { invoice: bolt11.to_string() })
            .await?;
        Ok(decoded.payment_hash)
    }

    /// Join a payment with what we issued for it. `None` for on-chain payments.
    fn join(&self, payment: &Payment) -> Option<Invoice> {
        let (payment_hash, preimage) = hash_and_preimage(payment)?;
        let issued = self.issued.lock().unwrap().get(&payment_hash).cloned();

        let state = match payment.status() {
            PaymentStatus::Succeeded => State::Settled,
            PaymentStatus::Failed => State::Failed,
            PaymentStatus::Pending => match &issued {
                Some(i) if i.expires_at <= now() => State::Expired,
                _ => State::Pending,
            },
        };

        Some(Invoice {
            amount_msat: payment
                .amount_msat
                .or_else(|| issued.as_ref().map(|i| i.amount_msat))
                .unwrap_or(0),
            issued,
            incoming: payment.direction() == PaymentDirection::Inbound,
            preimage: preimage.filter(|_| state == State::Settled),
            state,
            fees_paid_msat: payment.fee_paid_msat.unwrap_or(0),
            updated_at: payment.latest_update_timestamp,
            payment_hash,
        })
    }
}

/// The payment hash of a Lightning payment. `None` for on-chain payments.
pub fn payment_hash(payment: &Payment) -> Option<String> {
    hash_and_preimage(payment).map(|(hash, _)| hash)
}

fn hash_and_preimage(payment: &Payment) -> Option<(String, Option<String>)> {
    Some(match payment.kind.as_ref()?.kind.as_ref()? {
        payment_kind::Kind::Bolt11(p) => (p.hash.clone(), p.preimage.clone()),
        payment_kind::Kind::Bolt11Jit(p) => (p.hash.clone(), p.preimage.clone()),
        payment_kind::Kind::Spontaneous(p) => (p.hash.clone(), p.preimage.clone()),
        payment_kind::Kind::Bolt12Offer(p) => (p.hash.clone()?, p.preimage.clone()),
        payment_kind::Kind::Bolt12Refund(p) => (p.hash.clone()?, p.preimage.clone()),
        payment_kind::Kind::Onchain(_) => return None,
    })
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("clock before 1970").as_secs()
}

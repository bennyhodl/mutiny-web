// The wallet API the UI talks to. Every function here maps onto one or more
// ldk-server RPCs through the sidecar. The UI gets this module as `sw` from the
// store, which keeps the call sites close to what they were with mutiny-wasm.

import {
    Bolt11ReceiveResponse,
    Bolt11ReceiveViaJitChannelResponse,
    Bolt12ReceiveResponse,
    Channel,
    DecodeInvoiceResponse,
    DecodeOfferResponse,
    GetBalancesResponse,
    GetNodeInfoResponse,
    GetPaymentDetailsResponse,
    GraphGetNodeResponse,
    ListChannelsResponse,
    ListPaymentsResponse,
    ListPeersResponse,
    OnchainReceiveResponse,
    OnchainSendResponse,
    OpenChannelResponse,
    Payment,
    rpc,
    RpcError,
    SendResponse
} from "./ldkApi";
import {
    ActivityItem,
    InvoiceStatus,
    MutinyBalance,
    MutinyChannel,
    MutinyInvoice,
    MutinyPeer,
    NodeInfo,
    OnChainTx
} from "./types";

const DEFAULT_INVOICE_EXPIRY_SECS = 60 * 60 * 24;
/** How long we wait for an outbound Lightning payment to settle. */
const SEND_TIMEOUT_MS = 90_000;
const SEND_POLL_MS = 500;

/**
 * ldk-node keys on-chain payments by the txid's raw bytes, which is the
 * byte-reversed form of the hex txid everyone displays.
 */
export function txidToPaymentId(txid: string): string {
    return txid.match(/../g)!.reverse().join("");
}

const KNOWN_ONCHAIN_KEY = "known_onchain_txids";

/**
 * ldk-server only lists payments that produced a node event, and on-chain
 * transactions produce none. We keep the txids we learn about (our own sends)
 * so the activity list can still show them.
 */
function knownOnchainTxids(): string[] {
    try {
        return JSON.parse(localStorage.getItem(KNOWN_ONCHAIN_KEY) ?? "[]");
    } catch {
        return [];
    }
}

export function rememberOnchainTxid(txid: string): void {
    const known = knownOnchainTxids();
    if (!known.includes(txid)) {
        known.unshift(txid);
        localStorage.setItem(
            KNOWN_ONCHAIN_KEY,
            JSON.stringify(known.slice(0, 200))
        );
    }
}

function msatToSats(msat?: number): bigint {
    if (msat === undefined || msat === null) return 0n;
    return BigInt(Math.floor(msat / 1000));
}

function satsToMsat(sats: bigint | number): number {
    return Number(sats) * 1000;
}

function paymentStatus(p: Payment): InvoiceStatus {
    if (p.status === "SUCCEEDED") return "paid";
    if (p.status === "FAILED") return "failed";
    return "pending";
}

function paymentKind(p: Payment) {
    return p.kind?.kind ?? {};
}

function paymentMethod(p: Payment): string {
    const k = paymentKind(p);
    if (k.onchain) return "On-chain";
    if (k.bolt11) return "Lightning";
    if (k.bolt11_jit) return "Lightning (JIT channel)";
    if (k.bolt12_offer) return "BOLT12 offer";
    if (k.bolt12_refund) return "BOLT12 refund";
    if (k.spontaneous) return "Keysend";
    return "Payment";
}

function paymentHash(p: Payment): string | undefined {
    const k = paymentKind(p);
    return (
        k.bolt11?.hash ??
        k.bolt11_jit?.hash ??
        k.bolt12_offer?.hash ??
        k.bolt12_refund?.hash ??
        k.spontaneous?.hash
    );
}

function paymentPreimage(p: Payment): string | undefined {
    const k = paymentKind(p);
    return (
        k.bolt11?.preimage ??
        k.bolt11_jit?.preimage ??
        k.bolt12_offer?.preimage ??
        k.bolt12_refund?.preimage ??
        k.spontaneous?.preimage
    );
}

export function paymentToInvoice(p: Payment, bolt11?: string): MutinyInvoice {
    const status = paymentStatus(p);
    return {
        bolt11,
        payment_hash: paymentHash(p) ?? p.id,
        preimage: paymentPreimage(p),
        amount_sats: msatToSats(p.amount_msat),
        fees_paid: p.fee_paid_msat ? msatToSats(p.fee_paid_msat) : undefined,
        inbound: p.direction === "INBOUND",
        paid: status === "paid",
        expire: 0,
        expired: false,
        last_updated: p.latest_update_timestamp,
        status
    };
}

export function paymentToActivity(p: Payment): ActivityItem {
    const k = paymentKind(p);
    const onchain = k.onchain;
    return {
        kind: onchain ? "OnChain" : "Lightning",
        id: onchain ? onchain.txid : p.id,
        amount_sats: Number(msatToSats(p.amount_msat)),
        fee_sats: p.fee_paid_msat
            ? Number(msatToSats(p.fee_paid_msat))
            : undefined,
        inbound: p.direction === "INBOUND",
        status: paymentStatus(p),
        last_updated: p.latest_update_timestamp,
        method: paymentMethod(p),
        confirmed: onchain ? !!onchain.status?.status?.confirmed : undefined
    };
}

function channelToMutiny(c: Channel): MutinyChannel {
    return {
        user_chan_id: c.user_channel_id,
        channel_id: c.channel_id,
        peer: c.counterparty_node_id,
        balance: msatToSats(c.outbound_capacity_msat),
        size: BigInt(c.channel_value_sats),
        reserve: BigInt(c.unspendable_punishment_reserve ?? 0),
        inbound: msatToSats(c.inbound_capacity_msat),
        outpoint: c.funding_txo
            ? `${c.funding_txo.txid}:${c.funding_txo.vout}`
            : undefined,
        confirmations_required: c.confirmations_required,
        confirmations: c.confirmations,
        is_outbound: c.is_outbound,
        is_usable: c.is_usable,
        is_ready: c.is_channel_ready
    };
}

// ---- Node ------------------------------------------------------------------

export async function get_node_info(): Promise<NodeInfo> {
    const info = await rpc<GetNodeInfoResponse>("GetNodeInfo");
    return {
        node_id: info.node_id,
        alias: info.node_alias,
        network: info.network.toLowerCase(),
        block_height: info.current_best_block?.height,
        block_hash: info.current_best_block?.block_hash,
        listening_addresses: info.listening_addresses ?? [],
        node_uris: info.node_uris ?? [],
        last_lightning_sync: info.latest_lightning_wallet_sync_timestamp,
        last_onchain_sync: info.latest_onchain_wallet_sync_timestamp
    };
}

export async function get_balance(): Promise<MutinyBalance> {
    const b = await rpc<GetBalancesResponse>("GetBalances");
    const total = BigInt(b.total_onchain_balance_sats);
    const spendable = BigInt(b.spendable_onchain_balance_sats);
    const reserve = BigInt(b.total_anchor_channels_reserve_sats);
    let unconfirmed = total - spendable - reserve;
    if (unconfirmed < 0n) unconfirmed = 0n;

    let force_close = 0n;
    for (const pending of b.pending_balances_from_channel_closures ?? []) {
        const inner = (pending as { balance_type?: Record<string, unknown> })
            .balance_type;
        const entry = inner ? Object.values(inner)[0] : undefined;
        const sats = (entry as { amount_satoshis?: number } | undefined)
            ?.amount_satoshis;
        if (sats) force_close += BigInt(sats);
    }

    return {
        confirmed: spendable,
        unconfirmed,
        lightning: BigInt(b.total_lightning_balance_sats),
        force_close,
        reserve
    };
}

// ---- Payments history --------------------------------------------------------

export async function get_activity(limit: number): Promise<ActivityItem[]> {
    const items: ActivityItem[] = [];
    let page_token: ListPaymentsResponse["next_page_token"] | undefined;
    // ldk-server pages newest first; keep pulling until we have `limit`.
    for (let i = 0; i < 10 && items.length < limit; i++) {
        const res = await rpc<ListPaymentsResponse>(
            "ListPayments",
            page_token ? { page_token } : {}
        );
        for (const p of res.payments ?? []) {
            items.push(paymentToActivity(p));
        }
        page_token = res.next_page_token;
        if (!page_token) break;
    }

    // On-chain sends we made from this wallet.
    const onchain = await Promise.all(
        knownOnchainTxids()
            .slice(0, limit)
            .map((txid) => get_payment(txidToPaymentId(txid)))
    );
    for (const p of onchain) {
        if (p) items.push(paymentToActivity(p));
    }

    items.sort((a, b) => b.last_updated - a.last_updated);
    return items.slice(0, limit);
}

export async function get_payment(id: string): Promise<Payment | undefined> {
    try {
        const res = await rpc<GetPaymentDetailsResponse>("GetPaymentDetails", {
            payment_id: id
        });
        return res.payment;
    } catch (e) {
        if (e instanceof RpcError && e.httpStatus === 400) return undefined;
        throw e;
    }
}

/** Look up a payment by its payment hash (the payment id for Lightning). */
export async function get_invoice_by_hash(
    hash: string
): Promise<MutinyInvoice | undefined> {
    const p = await get_payment(hash);
    return p ? paymentToInvoice(p) : undefined;
}

/** Look up the payment that belongs to a BOLT11 invoice string. */
export async function get_invoice(
    bolt11: string
): Promise<MutinyInvoice | undefined> {
    const decoded = await rpc<DecodeInvoiceResponse>("DecodeInvoice", {
        invoice: bolt11
    });
    const p = await get_payment(decoded.payment_hash);
    if (!p) return undefined;
    const inv = paymentToInvoice(p, bolt11);
    inv.description = decoded.description;
    inv.expire = decoded.timestamp + decoded.expiry;
    inv.expired = decoded.is_expired;
    inv.payee_pubkey = decoded.destination;
    return inv;
}

export async function get_transaction(
    txid: string
): Promise<OnChainTx | undefined> {
    const p = await get_payment(txidToPaymentId(txid));
    if (!p) return undefined;
    const onchain = paymentKind(p).onchain;
    const confirmed = onchain?.status?.status?.confirmed;
    const sats = Number(msatToSats(p.amount_msat));
    return {
        txid,
        received: p.direction === "INBOUND" ? sats : 0,
        sent: p.direction === "OUTBOUND" ? sats : 0,
        fee: p.fee_paid_msat ? Number(msatToSats(p.fee_paid_msat)) : undefined,
        confirmed: !!confirmed,
        confirmation_time: confirmed
            ? { height: confirmed.height, timestamp: confirmed.timestamp }
            : undefined
    };
}

// ---- Receive ---------------------------------------------------------------

export async function decode_invoice(bolt11: string): Promise<MutinyInvoice> {
    const d = await rpc<DecodeInvoiceResponse>("DecodeInvoice", {
        invoice: bolt11
    });
    return {
        bolt11,
        description: d.description,
        payment_hash: d.payment_hash,
        payee_pubkey: d.destination,
        amount_sats: d.amount_msat ? msatToSats(d.amount_msat) : undefined,
        expire: d.timestamp + d.expiry,
        expired: d.is_expired,
        paid: false,
        inbound: false,
        last_updated: d.timestamp,
        status: "pending"
    };
}

export async function decode_offer(
    offer: string
): Promise<DecodeOfferResponse> {
    return rpc<DecodeOfferResponse>("DecodeOffer", { offer });
}

export async function create_invoice(
    amount_sats: bigint,
    description?: string
): Promise<MutinyInvoice> {
    const res = await rpc<Bolt11ReceiveResponse>("Bolt11Receive", {
        amount_msat: amount_sats > 0n ? satsToMsat(amount_sats) : undefined,
        description: { kind: { direct: description ?? "" } },
        expiry_secs: DEFAULT_INVOICE_EXPIRY_SECS
    });
    const inv = await decode_invoice(res.invoice);
    inv.inbound = true;
    return inv;
}

/** Ask the LSP for a just-in-time channel when the node has no inbound liquidity. */
export async function create_jit_invoice(
    amount_sats: bigint,
    description?: string
): Promise<MutinyInvoice> {
    const res = await rpc<Bolt11ReceiveViaJitChannelResponse>(
        "Bolt11ReceiveViaJitChannel",
        {
            amount_msat: satsToMsat(amount_sats),
            description: { kind: { direct: description ?? "" } },
            expiry_secs: DEFAULT_INVOICE_EXPIRY_SECS
        }
    );
    const inv = await decode_invoice(res.invoice);
    inv.inbound = true;
    return inv;
}

export async function create_offer(
    amount_sats: bigint,
    description?: string
): Promise<{ offer: string; offer_id: string }> {
    const res = await rpc<Bolt12ReceiveResponse>("Bolt12Receive", {
        description: description ?? "",
        amount_msat: amount_sats > 0n ? satsToMsat(amount_sats) : undefined
    });
    return { offer: res.offer, offer_id: res.offer_id };
}

/** The newest successful inbound payment for an offer, if any. */
export async function find_offer_payment(
    offer_id: string
): Promise<MutinyInvoice | undefined> {
    const res = await rpc<ListPaymentsResponse>("ListPayments");
    const p = (res.payments ?? []).find(
        (p) =>
            p.direction === "INBOUND" &&
            p.status === "SUCCEEDED" &&
            paymentKind(p).bolt12_offer?.offer_id === offer_id
    );
    return p ? paymentToInvoice(p) : undefined;
}

export async function get_new_address(): Promise<{ address: string }> {
    return rpc<OnchainReceiveResponse>("OnchainReceive");
}

// ---- Send ------------------------------------------------------------------

/** Poll until an outbound payment leaves the pending state. */
async function wait_for_payment(payment_id: string): Promise<Payment> {
    const start = Date.now();
    let last: Payment | undefined;
    while (Date.now() - start < SEND_TIMEOUT_MS) {
        last = await get_payment(payment_id);
        if (last && last.status !== "PENDING") return last;
        await new Promise((r) => setTimeout(r, SEND_POLL_MS));
    }
    if (last) return last;
    throw new Error("Payment not found");
}

function assert_paid(p: Payment, what: string): void {
    if (p.status === "FAILED") {
        throw new Error(`${what} failed`);
    }
    if (p.status === "PENDING") {
        throw new Error(`${what} is still pending, check the activity list`);
    }
}

export async function pay_invoice(
    bolt11: string,
    amount_sats?: bigint
): Promise<MutinyInvoice> {
    const res = await rpc<SendResponse>("Bolt11Send", {
        invoice: bolt11,
        amount_msat: amount_sats ? satsToMsat(amount_sats) : undefined
    });
    const p = await wait_for_payment(res.payment_id!);
    assert_paid(p, "Payment");
    return paymentToInvoice(p, bolt11);
}

export async function pay_offer(
    offer: string,
    amount_sats?: bigint,
    payer_note?: string
): Promise<MutinyInvoice> {
    const res = await rpc<SendResponse>("Bolt12Send", {
        offer,
        amount_msat: amount_sats ? satsToMsat(amount_sats) : undefined,
        payer_note: payer_note || undefined
    });
    const p = await wait_for_payment(res.payment_id!);
    assert_paid(p, "Payment");
    return paymentToInvoice(p);
}

export async function keysend(
    node_id: string,
    amount_sats: bigint
): Promise<MutinyInvoice> {
    const res = await rpc<SendResponse>("SpontaneousSend", {
        node_id,
        amount_msat: satsToMsat(amount_sats)
    });
    const p = await wait_for_payment(res.payment_id!);
    assert_paid(p, "Keysend");
    return paymentToInvoice(p);
}

export async function send_to_address(
    address: string,
    amount_sats: bigint,
    fee_rate_sat_per_vb?: number
): Promise<string> {
    const res = await rpc<OnchainSendResponse>("OnchainSend", {
        address,
        amount_sats: Number(amount_sats),
        fee_rate_sat_per_vb
    });
    rememberOnchainTxid(res.txid);
    return res.txid;
}

export async function sweep_wallet(
    address: string,
    fee_rate_sat_per_vb?: number
): Promise<string> {
    const res = await rpc<OnchainSendResponse>("OnchainSend", {
        address,
        send_all: true,
        fee_rate_sat_per_vb
    });
    rememberOnchainTxid(res.txid);
    return res.txid;
}

// ---- Channels & peers --------------------------------------------------------

export async function list_channels(): Promise<MutinyChannel[]> {
    const res = await rpc<ListChannelsResponse>("ListChannels");
    return (res.channels ?? []).map(channelToMutiny);
}

export async function open_channel(
    node_pubkey: string,
    address: string,
    amount_sats: bigint,
    announce = false
): Promise<string> {
    const res = await rpc<OpenChannelResponse>("OpenChannel", {
        node_pubkey,
        address,
        channel_amount_sats: Number(amount_sats),
        announce_channel: announce,
        disable_counterparty_reserve: false
    });
    return res.user_channel_id;
}

export async function close_channel(
    channel: MutinyChannel,
    force: boolean
): Promise<void> {
    const body = {
        user_channel_id: channel.user_chan_id,
        counterparty_node_id: channel.peer
    };
    if (force) {
        await rpc("ForceCloseChannel", {
            ...body,
            force_close_reason: "Closed from Mutiny"
        });
    } else {
        await rpc("CloseChannel", body);
    }
}

export async function list_peers(): Promise<MutinyPeer[]> {
    const res = await rpc<ListPeersResponse>("ListPeers");
    return (res.peers ?? []).map((p) => ({
        pubkey: p.node_id,
        connection_string: p.address ? `${p.node_id}@${p.address}` : undefined,
        is_connected: p.is_connected,
        is_persisted: p.is_persisted
    }));
}

/** Accepts `pubkey@host:port`. */
export async function connect_to_peer(
    connection_string: string
): Promise<void> {
    const [node_pubkey, address] = connection_string.trim().split("@");
    if (!node_pubkey || !address) {
        throw new Error("Expected pubkey@host:port");
    }
    await rpc("ConnectPeer", { node_pubkey, address, persist: true });
}

export async function disconnect_peer(node_pubkey: string): Promise<void> {
    await rpc("DisconnectPeer", { node_pubkey });
}

export async function get_node_alias(
    node_id: string
): Promise<string | undefined> {
    try {
        const res = await rpc<GraphGetNodeResponse>("GraphGetNode", {
            node_id
        });
        return res.node?.announcement_info?.alias || undefined;
    } catch {
        return undefined;
    }
}

// ---- Helpers ---------------------------------------------------------------

export function convert_sats_to_btc(sats: bigint | number): number {
    return Number(sats) / 100_000_000;
}

export function convert_btc_to_sats(btc: number): bigint {
    return BigInt(Math.round(btc * 100_000_000));
}

export type WalletApi = typeof import("./wallet");

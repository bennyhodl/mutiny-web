// Typed client for the mutiny-sidecar. The browser only ever speaks plain JSON
// to the sidecar (same-origin in prod, Vite proxy in dev) — the sidecar holds the
// ldk-server secrets and does the gRPC / TLS / HMAC work.
//
// The JSON shape is ldk-server-grpc's serde representation (snake_case), so these
// types mirror the proto field names. Only the fields the wallet uses are typed.

export class RpcError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly httpStatus: number
    ) {
        super(message);
        this.name = "RpcError";
    }
}

/**
 * Fired when the sidecar rejects a request for lack of a session. The store
 * listens for it and sends the user to the login screen.
 */
export const UNAUTHENTICATED_EVENT = "mutiny:unauthenticated";

async function toRpcError(res: Response): Promise<RpcError> {
    if (res.status === 401) {
        window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    }
    let code = "Error";
    let message = res.statusText;
    try {
        const j = await res.json();
        code = j.code ?? code;
        message = j.message ?? message;
    } catch {
        /* non-JSON error */
    }
    return new RpcError(code, message, res.status);
}

/** Call a unary RPC on the sidecar: POST /api/rpc/<Method> with a JSON request. */
export async function rpc<TRes>(
    method: string,
    body: object = {}
): Promise<TRes> {
    const res = await fetch(`/api/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw await toRpcError(res);
    return res.json() as Promise<TRes>;
}

// ---- Auth ------------------------------------------------------------------

export type AuthStatus = {
    auth_enabled: boolean;
    logged_in: boolean;
    has_passkeys: boolean;
};

export async function authMe(): Promise<AuthStatus> {
    const res = await fetch("/api/auth/me");
    if (res.status === 401) {
        try {
            return { ...(await res.json()), logged_in: false };
        } catch {
            return {
                auth_enabled: true,
                logged_in: false,
                has_passkeys: false
            };
        }
    }
    if (!res.ok) throw await toRpcError(res);
    return res.json();
}

export async function authLogin(password: string): Promise<void> {
    const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
    });
    if (!res.ok) {
        let message = "Wrong password";
        try {
            message = (await res.json()).message ?? message;
        } catch {
            /* ignore */
        }
        throw new RpcError("Unauthenticated", message, res.status);
    }
}

export async function authLogout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
}

export type WalletConfig = { network: string };

export async function walletConfig(): Promise<WalletConfig> {
    const res = await fetch("/api/config");
    if (!res.ok) throw await toRpcError(res);
    return res.json();
}

/** How outside apps such as Zaprite pay this node. Both can only receive. */
export type Connections = {
    /** Receive-only Nostr Wallet Connect; null when WALLET_NWC_RELAY is unset. */
    nwc: { uri: string; relay: string; methods: string[] } | null;
    /** user@domain; null when WALLET_LNURL_USERNAME is unset. */
    lightning_address: string | null;
};

export async function connections(): Promise<Connections> {
    const res = await fetch("/api/connections");
    if (!res.ok) throw await toRpcError(res);
    return res.json();
}

// ---- Response types (subset) ----------------------------------------------

export interface BestBlock {
    block_hash: string;
    height: number;
}

export interface GetNodeInfoResponse {
    node_id: string;
    current_best_block?: BestBlock;
    latest_lightning_wallet_sync_timestamp?: number;
    latest_onchain_wallet_sync_timestamp?: number;
    listening_addresses?: string[];
    announcement_addresses?: string[];
    node_alias?: string;
    node_uris?: string[];
    network: string;
}

export interface GetBalancesResponse {
    total_onchain_balance_sats: number;
    spendable_onchain_balance_sats: number;
    total_anchor_channels_reserve_sats: number;
    total_lightning_balance_sats: number;
    lightning_balances?: unknown[];
    pending_balances_from_channel_closures?: unknown[];
}

export interface OutPoint {
    txid: string;
    vout: number;
}

export interface Channel {
    channel_id: string;
    counterparty_node_id: string;
    funding_txo?: OutPoint;
    user_channel_id: string;
    unspendable_punishment_reserve?: number;
    channel_value_sats: number;
    outbound_capacity_msat: number;
    inbound_capacity_msat: number;
    confirmations_required?: number;
    confirmations?: number;
    is_outbound: boolean;
    is_channel_ready: boolean;
    is_usable: boolean;
    is_announced: boolean;
    next_outbound_htlc_limit_msat: number;
}

export interface ListChannelsResponse {
    channels: Channel[];
}

/** PaymentKind is a proto oneof nested in a field also named `kind`. */
export interface PaymentKind {
    kind?: {
        onchain?: {
            txid: string;
            status?: {
                status?: {
                    confirmed?: {
                        block_hash: string;
                        height: number;
                        timestamp: number;
                    };
                    unconfirmed?: Record<string, never>;
                };
            };
        };
        bolt11?: { hash: string; preimage?: string; secret?: string };
        bolt11_jit?: {
            hash: string;
            preimage?: string;
            counterparty_skimmed_fee_msat?: number;
        };
        bolt12_offer?: { hash?: string; preimage?: string; offer_id: string };
        bolt12_refund?: { hash?: string; preimage?: string };
        spontaneous?: { hash: string; preimage?: string };
    };
}

export interface Payment {
    id: string;
    kind?: PaymentKind;
    amount_msat?: number;
    fee_paid_msat?: number;
    direction: "INBOUND" | "OUTBOUND";
    status: "PENDING" | "SUCCEEDED" | "FAILED";
    latest_update_timestamp: number;
}

export interface PageToken {
    token: string;
    index: number;
}

export interface ListPaymentsResponse {
    payments: Payment[];
    next_page_token?: PageToken;
}

export interface GetPaymentDetailsResponse {
    payment?: Payment;
}

export interface Peer {
    node_id: string;
    address: string;
    is_persisted: boolean;
    is_connected: boolean;
}

export interface ListPeersResponse {
    peers: Peer[];
}

export interface OnchainReceiveResponse {
    address: string;
}

export interface OnchainSendResponse {
    txid: string;
}

export interface Bolt11ReceiveResponse {
    invoice: string;
    payment_hash: string;
    payment_secret: string;
}

export interface Bolt11ReceiveViaJitChannelResponse {
    invoice: string;
}

export interface Bolt12ReceiveResponse {
    offer: string;
    offer_id: string;
}

export interface SendResponse {
    payment_id?: string;
    txid?: string;
    bolt11_payment_id?: string;
    bolt12_payment_id?: string;
}

export interface OpenChannelResponse {
    user_channel_id: string;
}

export interface DecodeInvoiceResponse {
    destination: string;
    payment_hash: string;
    amount_msat?: number;
    timestamp: number;
    expiry: number;
    description?: string;
    description_hash?: string;
    is_expired: boolean;
    currency: string;
}

export interface DecodeOfferResponse {
    offer_id: string;
    description?: string;
    issuer?: string;
    amount?: { amount?: { bitcoin_msat?: number; currency_amount?: unknown } };
    absolute_expiry?: number;
    chains?: string[];
    is_expired: boolean;
}

export interface GraphGetNodeResponse {
    node?: { announcement_info?: { alias?: string; addresses?: string[] } };
}

// ---- Event stream (SSE) ---------------------------------------------------

export type LdkEvent = {
    event?: {
        payment_received?: { payment?: Payment };
        payment_successful?: { payment?: Payment };
        payment_failed?: { payment?: Payment };
        payment_claimable?: { payment?: Payment };
        payment_forwarded?: unknown;
        channel_state_changed?: unknown;
    };
};

/** Subscribe to the live event stream. Returns an unsubscribe function. */
export function subscribeEvents(
    onEvent: (e: LdkEvent) => void,
    onError?: () => void,
    onOpen?: () => void
): () => void {
    const es = new EventSource("/api/events");
    es.onopen = () => onOpen?.();
    es.addEventListener("ldk", (ev) => {
        try {
            onEvent(JSON.parse((ev as MessageEvent).data));
        } catch {
            /* ignore */
        }
    });
    es.addEventListener("error", () => {
        onError?.();
        // EventSource hides the HTTP status and reconnects forever, so an
        // expired session would otherwise become a silent 401 retry loop.
        void fetch("/api/auth/me").then((res) => {
            if (res.status === 401) {
                es.close();
                window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
            }
        });
    });
    return () => es.close();
}

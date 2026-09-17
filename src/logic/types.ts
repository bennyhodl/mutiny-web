// Wallet-facing types. These replace the mutiny-wasm types the UI used to
// import, and are shaped by what ldk-server can tell us.

export type MutinyBalance = {
    /** Spendable on-chain sats. */
    confirmed: bigint;
    /** On-chain sats that are not spendable yet. */
    unconfirmed: bigint;
    /** Sats we can spend over Lightning. */
    lightning: bigint;
    /** Sats that are on the way back on-chain from closed channels. */
    force_close: bigint;
    /** Sats held back as anchor channel reserve. */
    reserve: bigint;
};

export type InvoiceStatus = "pending" | "paid" | "failed";

export type MutinyInvoice = {
    bolt11?: string;
    description?: string;
    payment_hash: string;
    preimage?: string;
    payee_pubkey?: string;
    amount_sats?: bigint;
    /** Unix seconds when the invoice expires. */
    expire: number;
    expired: boolean;
    paid: boolean;
    fees_paid?: bigint;
    inbound: boolean;
    last_updated: number;
    status: InvoiceStatus;
};

export type MutinyChannel = {
    user_chan_id: string;
    channel_id: string;
    peer: string;
    /** Our spendable sats in the channel. */
    balance: bigint;
    /** Channel capacity in sats. */
    size: bigint;
    /** Our reserve in sats. */
    reserve: bigint;
    /** Sats the peer can send us. */
    inbound: bigint;
    outpoint?: string;
    confirmations_required?: number;
    confirmations?: number;
    is_outbound: boolean;
    is_usable: boolean;
    is_ready: boolean;
};

export type MutinyPeer = {
    pubkey: string;
    connection_string?: string;
    is_connected: boolean;
    is_persisted: boolean;
    alias?: string;
};

export type NodeInfo = {
    node_id: string;
    alias?: string;
    network: string;
    block_height?: number;
    block_hash?: string;
    listening_addresses: string[];
    node_uris: string[];
    last_lightning_sync?: number;
    last_onchain_sync?: number;
};

export type ActivityKind = "Lightning" | "OnChain";

export type ActivityItem = {
    kind: ActivityKind;
    /** Payment id: the payment hash for Lightning, the txid for on-chain. */
    id: string;
    amount_sats: number;
    fee_sats?: number;
    inbound: boolean;
    status: InvoiceStatus;
    /** Unix seconds. */
    last_updated: number;
    /** Human label for the payment method, e.g. "BOLT12", "Keysend". */
    method: string;
    confirmed?: boolean;
};

export type OnChainTx = {
    txid: string;
    received: number;
    sent: number;
    fee?: number;
    confirmed: boolean;
    confirmation_time?: { height: number; timestamp: number };
};

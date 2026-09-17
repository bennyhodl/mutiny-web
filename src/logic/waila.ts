// "What Am I Looking At": parse a scanned or pasted string into something the
// wallet can pay. Runs fully in the browser; the node only decodes the invoice
// or offer when we get to the send screen.

import { Result } from "~/utils";

export type ParsedParams = {
    original: string;
    address?: string;
    invoice?: string;
    offer?: string;
    amount_sats?: bigint;
    network?: string;
    memo?: string;
    node_pubkey?: string;
};

const HEX_PUBKEY = /^0[23][0-9a-fA-F]{64}$/;

function invoiceNetwork(invoice: string): string | undefined {
    const lower = invoice.toLowerCase();
    if (lower.startsWith("lnbcrt")) return "regtest";
    if (lower.startsWith("lntbs")) return "signet";
    if (lower.startsWith("lntb")) return "testnet";
    if (lower.startsWith("lnbc")) return "bitcoin";
    return undefined;
}

function addressNetwork(address: string): string | undefined {
    const lower = address.toLowerCase();
    if (lower.startsWith("bcrt1")) return "regtest";
    if (lower.startsWith("tb1")) return "testnet";
    if (lower.startsWith("bc1")) return "bitcoin";
    if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return "bitcoin";
    if (/^[mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return "testnet";
    return undefined;
}

function isInvoice(s: string): boolean {
    return /^ln(bc|tb|bcrt|tbs)[0-9a-z]{20,}$/i.test(s);
}

function isOffer(s: string): boolean {
    return /^lno1[0-9a-z]{20,}$/i.test(s);
}

function btcToSats(btc: string): bigint | undefined {
    const n = Number(btc);
    if (!isFinite(n) || n < 0) return undefined;
    return BigInt(Math.round(n * 100_000_000));
}

export function parseParams(input: string): ParsedParams {
    let str = input.trim();
    const params: ParsedParams = { original: input };

    // "lightning:" prefix, with or without the "//"
    if (/^lightning:/i.test(str)) {
        str = str.replace(/^lightning:(\/\/)?/i, "");
    }

    // BIP21
    if (/^bitcoin:/i.test(str)) {
        const rest = str.replace(/^bitcoin:(\/\/)?/i, "");
        const [address, query] = rest.split("?");
        if (address) {
            params.address = address;
            params.network = addressNetwork(address);
        }
        const q = new URLSearchParams(query ?? "");
        const amount = q.get("amount");
        if (amount) params.amount_sats = btcToSats(amount);
        const label = q.get("label") || q.get("message");
        if (label) params.memo = label;
        const ln = q.get("lightning");
        if (ln && isInvoice(ln)) {
            params.invoice = ln;
            params.network = params.network ?? invoiceNetwork(ln);
        }
        const lno = q.get("lno");
        if (lno && isOffer(lno)) params.offer = lno;
        if (!params.address && !params.invoice && !params.offer) {
            throw new Error("Invalid BIP21 URI");
        }
        return params;
    }

    if (isInvoice(str)) {
        params.invoice = str;
        params.network = invoiceNetwork(str);
        return params;
    }

    if (isOffer(str)) {
        params.offer = str;
        return params;
    }

    if (HEX_PUBKEY.test(str)) {
        params.node_pubkey = str.toLowerCase();
        return params;
    }

    const net = addressNetwork(str);
    if (net) {
        params.address = str;
        params.network = net;
        return params;
    }

    throw new Error("Invalid payment request");
}

/** regtest and signet share address prefixes with testnet, so treat those as the same. */
function sameNetwork(a: string, b: string): boolean {
    const norm = (n: string) =>
        n === "testnet" || n === "signet" || n === "regtest" ? "test" : n;
    return norm(a) === norm(b);
}

export async function toParsedParams(
    str: string,
    ourNetwork: string
): Promise<Result<ParsedParams>> {
    let params: ParsedParams;
    try {
        params = parseParams(str || "");
    } catch {
        return { ok: false, error: new Error("Invalid payment request") };
    }

    const network = params.network ?? ourNetwork;

    if (!sameNetwork(network, ourNetwork)) {
        return {
            ok: false,
            error: new Error(
                `Destination is for ${network} but you're on ${ourNetwork}`
            )
        };
    }

    return { ok: true, value: { ...params, network: ourNetwork } };
}

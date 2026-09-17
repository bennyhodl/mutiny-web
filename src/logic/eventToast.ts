// Turn a node event into a short toast, or nothing when it is not worth one.

import { LdkEvent, Payment } from "./ldkApi";
import { MutinyBalance } from "./types";

export type EventToast = { title: string; description: string };

function sats(p?: Payment): string {
    const n = Math.floor((p?.amount_msat ?? 0) / 1000);
    return `${n.toLocaleString()} sats`;
}

function channelState(state: unknown): string | undefined {
    const s = typeof state === "string" ? state : "";
    if (s.endsWith("PENDING") || state === 1) return "pending";
    if (s.endsWith("READY") || state === 2) return "ready";
    if (s.endsWith("OPEN_FAILED") || state === 3) return "open failed";
    if (s.endsWith("CLOSED") || state === 4) return "closed";
    return undefined;
}

export function eventToToast(event: LdkEvent): EventToast | undefined {
    const e = event.event ?? {};
    if (e.payment_received) {
        return {
            title: "Payment received",
            description: `+${sats(e.payment_received.payment)}`
        };
    }
    if (e.payment_successful) {
        return {
            title: "Payment sent",
            description: `-${sats(e.payment_successful.payment)}`
        };
    }
    if (e.payment_failed) {
        return {
            title: "Payment failed",
            description: sats(e.payment_failed.payment)
        };
    }
    if (e.payment_claimable) {
        return {
            title: "Payment waiting to be claimed",
            description: sats(e.payment_claimable.payment)
        };
    }
    if (e.payment_forwarded) {
        const fee = (e.payment_forwarded as { total_fee_earned_msat?: number })
            .total_fee_earned_msat;
        return {
            title: "Payment routed",
            description: fee
                ? `Earned ${Math.floor(fee / 1000).toLocaleString()} sats`
                : "A payment passed through your node"
        };
    }
    if (e.channel_state_changed) {
        const state = channelState(
            (e.channel_state_changed as { state?: unknown }).state
        );
        if (!state) return undefined;
        return {
            title: `Channel ${state}`,
            description:
                state === "ready"
                    ? "You can send and receive over it now"
                    : state === "pending"
                      ? "Waiting for the funding transaction to confirm"
                      : state === "closed"
                        ? "The funds return to your on-chain balance"
                        : "The channel could not be opened"
        };
    }
    return undefined;
}

/**
 * ldk-server sends no events for on-chain transactions, so we read them off
 * the balance: unconfirmed sats going up means a payment hit the mempool,
 * unconfirmed going down while confirmed goes up means it confirmed.
 */
export function onchainChangeToast(
    before: Partial<MutinyBalance> | undefined,
    after: MutinyBalance
): EventToast | undefined {
    if (!before) return undefined;
    const unconfirmedBefore = before.unconfirmed ?? 0n;
    const confirmedBefore = before.confirmed ?? 0n;

    if (after.unconfirmed > unconfirmedBefore) {
        const delta = after.unconfirmed - unconfirmedBefore;
        return {
            title: "Incoming on-chain payment",
            description: `+${delta.toLocaleString()} sats, waiting for a confirmation`
        };
    }
    if (
        after.unconfirmed < unconfirmedBefore &&
        after.confirmed > confirmedBefore
    ) {
        const delta = unconfirmedBefore - after.unconfirmed;
        return {
            title: "On-chain payment confirmed",
            description: `${delta.toLocaleString()} sats are spendable now`
        };
    }
    return undefined;
}

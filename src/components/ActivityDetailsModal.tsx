import { Dialog } from "@kobalte/core";
import { Copy, Link, Zap } from "lucide-solid";
import {
    createEffect,
    createResource,
    Match,
    Show,
    Suspense,
    Switch
} from "solid-js";

import {
    AmountFiat,
    AmountSats,
    ExternalLink,
    FancyCard,
    HackActivityType,
    Hr,
    InfoBox,
    KeyValue,
    ModalCloseButton,
    TruncateMiddle,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { MutinyInvoice, OnChainTx } from "~/logic/types";
import { useMegaStore } from "~/state/megaStore";
import { mempoolTxUrl, prettyPrintTime, useCopy } from "~/utils";

export const OVERLAY = "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm";
export const DIALOG_POSITIONER =
    "fixed inset-0 z-50 flex items-center justify-center";
export const DIALOG_CONTENT =
    "max-w-[500px] w-[90vw] max-h-device overflow-y-scroll disable-scrollbars bg-neutral-900/80 backdrop-blur-md shadow-xl rounded-xl border border-white/10";

function LightningHeader(props: { info: MutinyInvoice }) {
    const i18n = useI18n();

    return (
        <div class="flex flex-col items-center gap-4">
            <div class="flex flex-row items-center justify-center gap-[4px] font-normal">
                {props.info.inbound
                    ? i18n.t("activity.transaction_details.lightning_receive")
                    : i18n.t("activity.transaction_details.lightning_send")}
                <Zap class="h-4 w-4" />
            </div>
            <div class="flex flex-col items-center">
                <div
                    class="text-2xl"
                    classList={{ "text-m-green": props.info.inbound }}
                >
                    <AmountSats
                        amountSats={props.info.amount_sats}
                        icon={props.info.inbound ? "plus" : undefined}
                        denominationSize="lg"
                    />
                </div>
                <div class="text-lg text-white/70">
                    <AmountFiat
                        amountSats={props.info.amount_sats}
                        denominationSize="sm"
                    />
                </div>
            </div>
        </div>
    );
}

function OnchainHeader(props: { info: OnChainTx }) {
    const i18n = useI18n();

    const isSend = () => props.info.sent > props.info.received;

    const amount = () =>
        isSend() ? props.info.sent - props.info.received : props.info.received;

    return (
        <div class="flex flex-col items-center gap-4">
            <div class="flex flex-row items-center justify-center gap-[4px] font-normal">
                {isSend()
                    ? i18n.t("activity.transaction_details.onchain_send")
                    : i18n.t("activity.transaction_details.onchain_receive")}
                <Link class="h-4 w-4" />
            </div>
            <div class="flex flex-col items-center">
                <div class="text-2xl" classList={{ "text-m-green": !isSend() }}>
                    <AmountSats
                        amountSats={amount()}
                        icon={isSend() ? undefined : "plus"}
                        denominationSize="lg"
                    />
                </div>
                <div class="text-lg text-white/70">
                    <AmountFiat amountSats={amount()} denominationSize="sm" />
                </div>
            </div>
        </div>
    );
}

export function MiniStringShower(props: { text: string; hide?: boolean }) {
    const [copy, copied] = useCopy({ copiedTimeout: 1000 });

    return (
        <div class="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-1">
            <Switch>
                <Match when={props.hide}>
                    <input
                        type="password"
                        value={props.text}
                        class="flex bg-transparent font-mono"
                        readonly
                        disabled
                    />
                </Match>
                <Match when={true}>
                    <TruncateMiddle text={props.text} />
                </Match>
            </Switch>

            <button
                class="w-6 p-1"
                classList={{ "bg-m-red rounded": copied() }}
                onClick={() => copy(props.text)}
            >
                <Copy class="h-4 w-4" />
            </button>
        </div>
    );
}

function FormatPrettyPrint(props: { ts: number }) {
    return (
        <div>
            {prettyPrintTime(props.ts).split(",", 2).join(",")}
            <div class="text-right text-sm text-white/70">
                {prettyPrintTime(props.ts).split(", ")[2]}
            </div>
        </div>
    );
}

function LightningDetails(props: { info: MutinyInvoice }) {
    const i18n = useI18n();
    return (
        <VStack>
            <ul class="flex flex-col gap-4">
                <KeyValue key={i18n.t("activity.transaction_details.status")}>
                    <span
                        classList={{
                            "text-m-green": props.info.status === "paid",
                            "text-m-red": props.info.status === "failed"
                        }}
                    >
                        {props.info.status}
                    </span>
                </KeyValue>
                <Show when={props.info.fees_paid}>
                    <KeyValue key={i18n.t("activity.transaction_details.fee")}>
                        <AmountSats amountSats={props.info.fees_paid} />
                    </KeyValue>
                </Show>
                <KeyValue key={i18n.t("activity.transaction_details.date")}>
                    <FormatPrettyPrint ts={Number(props.info.last_updated)} />
                </KeyValue>
                <Show when={props.info.description}>
                    <KeyValue
                        key={i18n.t("activity.transaction_details.description")}
                    >
                        {props.info.description}
                    </KeyValue>
                </Show>
                <KeyValue
                    key={i18n.t("activity.transaction_details.payment_hash")}
                >
                    <MiniStringShower text={props.info.payment_hash} />
                </KeyValue>
                <Show when={props.info.bolt11}>
                    <KeyValue
                        key={i18n.t("activity.transaction_details.invoice")}
                    >
                        <MiniStringShower text={props.info.bolt11 ?? ""} />
                    </KeyValue>
                </Show>
                <Show when={props.info.preimage}>
                    <KeyValue
                        key={i18n.t("activity.transaction_details.preimage")}
                    >
                        <MiniStringShower text={props.info.preimage ?? ""} />
                    </KeyValue>
                </Show>
            </ul>
        </VStack>
    );
}

function OnchainDetails(props: { info: OnChainTx }) {
    const i18n = useI18n();
    const [state] = useMegaStore();

    return (
        <VStack>
            <ul class="flex flex-col gap-4">
                <KeyValue key={i18n.t("activity.transaction_details.status")}>
                    <span
                        classList={{
                            "text-m-green": props.info.confirmed
                        }}
                    >
                        {props.info.confirmed
                            ? i18n.t("common.confirmed")
                            : i18n.t("common.unconfirmed")}
                    </span>
                </KeyValue>
                <Show when={props.info.confirmation_time}>
                    <KeyValue key={i18n.t("activity.transaction_details.date")}>
                        <FormatPrettyPrint
                            ts={props.info.confirmation_time!.timestamp}
                        />
                    </KeyValue>
                </Show>
                <Show when={props.info.fee}>
                    <KeyValue key={i18n.t("activity.transaction_details.fee")}>
                        <AmountSats amountSats={props.info.fee} />
                    </KeyValue>
                </Show>
                <KeyValue key={i18n.t("activity.transaction_details.txid")}>
                    <MiniStringShower text={props.info.txid} />
                </KeyValue>
            </ul>
            <Show when={state.network && state.network !== "regtest"}>
                <div class="flex justify-center">
                    <ExternalLink
                        href={mempoolTxUrl(props.info.txid, state.network)}
                    >
                        {i18n.t("common.view_transaction")}
                    </ExternalLink>
                </div>
            </Show>
        </VStack>
    );
}

export function ActivityDetailsModal(props: {
    open: boolean;
    kind?: HackActivityType;
    id: string;
    setOpen: (open: boolean) => void;
}) {
    const [_state, _actions, sw] = useMegaStore();
    const i18n = useI18n();
    const id = () => props.id;
    const kind = () => props.kind;

    const [data, { refetch }] = createResource(async () => {
        try {
            if (kind() === "Lightning") {
                return await sw.get_invoice_by_hash(id());
            } else {
                return await sw.get_transaction(id());
            }
        } catch (e) {
            console.error(e);
            return undefined;
        }
    });

    createEffect(() => {
        if (props.id && props.kind && props.open) {
            refetch();
        }
    });

    return (
        <Dialog.Root open={props.open} onOpenChange={props.setOpen}>
            <Dialog.Portal>
                <Dialog.Overlay class={OVERLAY} />
                <div class={DIALOG_POSITIONER}>
                    <Dialog.Content class={DIALOG_CONTENT}>
                        <Suspense>
                            <div class="p-4">
                                <div class="flex justify-between">
                                    <div />
                                    <Dialog.CloseButton>
                                        <ModalCloseButton />
                                    </Dialog.CloseButton>
                                </div>
                                <Dialog.Title>
                                    <FancyCard>
                                        <Show when={data.latest}>
                                            <Switch>
                                                <Match
                                                    when={
                                                        kind() === "Lightning"
                                                    }
                                                >
                                                    <LightningHeader
                                                        info={
                                                            data() as MutinyInvoice
                                                        }
                                                    />
                                                </Match>
                                                <Match
                                                    when={kind() === "OnChain"}
                                                >
                                                    <OnchainHeader
                                                        info={
                                                            data() as OnChainTx
                                                        }
                                                    />
                                                </Match>
                                            </Switch>
                                        </Show>
                                    </FancyCard>
                                </Dialog.Title>
                                <Hr />
                                <Show when={!data.loading && !data.latest}>
                                    <VStack>
                                        <InfoBox accent="blue">
                                            {i18n.t(
                                                "activity.transaction_details.not_synced_yet"
                                            )}
                                        </InfoBox>
                                        <Show when={kind() === "OnChain"}>
                                            <ul class="flex flex-col gap-4">
                                                <KeyValue
                                                    key={i18n.t(
                                                        "activity.transaction_details.txid"
                                                    )}
                                                >
                                                    <MiniStringShower
                                                        text={id()}
                                                    />
                                                </KeyValue>
                                            </ul>
                                        </Show>
                                    </VStack>
                                </Show>
                                <Show when={data.latest}>
                                    <Switch>
                                        <Match when={kind() === "Lightning"}>
                                            <LightningDetails
                                                info={data() as MutinyInvoice}
                                            />
                                        </Match>
                                        <Match when={kind() === "OnChain"}>
                                            <OnchainDetails
                                                info={data() as OnChainTx}
                                            />
                                        </Match>
                                    </Switch>
                                </Show>
                            </div>
                        </Suspense>
                    </Dialog.Content>
                </div>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

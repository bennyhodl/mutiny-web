import { useLocation, useNavigate, useSearchParams } from "@solidjs/router";
import { Link, X, Zap } from "lucide-solid";
import {
    createEffect,
    createMemo,
    createSignal,
    JSX,
    Match,
    onMount,
    Show,
    Suspense,
    Switch
} from "solid-js";

import {
    ActivityDetailsModal,
    AmountEditable,
    AmountFiat,
    AmountSats,
    BackPop,
    Button,
    DefaultMain,
    Failure,
    Fee,
    HackActivityType,
    InfoBox,
    LoadingShimmer,
    MegaCheck,
    MethodChoice,
    MutinyWalletGuard,
    NavBar,
    showToast,
    SimpleInput,
    SmallHeader,
    StringShower,
    SuccessModal,
    UnstyledBackPop,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { MutinyInvoice } from "~/logic/types";
import { ParsedParams } from "~/logic/waila";
import { useMegaStore } from "~/state/megaStore";
import { eify, vibrateSuccess } from "~/utils";

export type SendSource = "lightning" | "onchain";

type SentDetails = {
    amount?: bigint;
    destination?: string;
    txid?: string;
    payment_hash?: string;
    failure_reason?: string;
    fee_estimate?: bigint | number;
};

function DestinationShower(props: {
    source: SendSource;
    description?: string;
    address?: string;
    invoice?: MutinyInvoice;
    offer?: string;
    nodePubkey?: string;
}) {
    return (
        <Switch>
            <Match when={props.address && props.source === "onchain"}>
                <DestinationItem
                    title="On-chain"
                    value={<StringShower text={props.address || ""} />}
                    icon={<Link class="h-4 w-4" />}
                />
            </Match>
            <Match when={props.invoice && props.source === "lightning"}>
                <DestinationItem
                    title="Lightning"
                    value={<StringShower text={props.invoice?.bolt11 || ""} />}
                    icon={<Zap class="h-4 w-4" />}
                />
            </Match>
            <Match when={props.offer && props.source === "lightning"}>
                <DestinationItem
                    title="BOLT12 offer"
                    value={<StringShower text={props.offer || ""} />}
                    icon={<Zap class="h-4 w-4" />}
                />
            </Match>
            <Match when={props.nodePubkey && props.source === "lightning"}>
                <DestinationItem
                    title="Keysend"
                    value={<StringShower text={props.nodePubkey || ""} />}
                    icon={<Zap class="h-4 w-4" />}
                />
            </Match>
        </Switch>
    );
}

export function DestinationItem(props: {
    title: string;
    value: JSX.Element;
    icon: JSX.Element;
}) {
    return (
        <div class="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,max-content)] items-center gap-2 rounded-xl bg-neutral-800 p-2">
            {props.icon}
            <div class="flex flex-col gap-1">
                <SmallHeader>{props.title}</SmallHeader>
                <div class="text-sm text-neutral-500">{props.value}</div>
            </div>
            <UnstyledBackPop default="/">
                <div class="h-8 w-8 rounded-full bg-m-grey-800 px-1 py-1">
                    <X class="h-6 w-6" />
                </div>
            </UnstyledBackPop>
        </div>
    );
}

export function Send() {
    const [state, actions, sw] = useMegaStore();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const i18n = useI18n();

    const [amountInput, setAmountInput] = createSignal("");
    const [whatForInput, setWhatForInput] = createSignal("");

    // These can be derived from the destination or set by the user
    const [amountSats, setAmountSats] = createSignal(0n);
    const [unparsedAmount, setUnparsedAmount] = createSignal(true);

    // These are derived from the incoming destination
    const [isAmtEditable, setIsAmtEditable] = createSignal(true);
    const [source, setSource] = createSignal<SendSource>("lightning");
    const [invoice, setInvoice] = createSignal<MutinyInvoice>();
    const [offer, setOffer] = createSignal<string>();
    const [nodePubkey, setNodePubkey] = createSignal<string>();
    const [address, setAddress] = createSignal<string>();
    const [description, setDescription] = createSignal<string>();

    // Is sending / sent
    const [sending, setSending] = createSignal(false);
    const [sentDetails, setSentDetails] = createSignal<SentDetails>();

    // Details Modal
    const [detailsOpen, setDetailsOpen] = createSignal(false);
    const [detailsKind, setDetailsKind] = createSignal<HackActivityType>();
    const [detailsId, setDetailsId] = createSignal("");

    // Errors
    const [error, setError] = createSignal<string>();

    function openDetailsModal() {
        const paymentTxId = sentDetails()?.txid ?? sentDetails()?.payment_hash;
        const kind = sentDetails()?.txid ? "OnChain" : "Lightning";

        if (!paymentTxId) {
            console.warn("No id provided to openDetailsModal");
            return;
        }
        setDetailsId(paymentTxId);
        setDetailsKind(kind);
        setDetailsOpen(true);
    }

    async function parsePaste(text: string) {
        await actions.handleIncomingString(
            text,
            (error) => {
                showToast(error);
            },
            (result) => {
                actions.setScanResult(result);
                navigate("/send", { state: { previous: "/search" } });
            }
        );
    }

    // send?invoice=... need to check for wallet because we can't parse until we have the wallet
    createEffect(() => {
        const invoice = Array.isArray(params.invoice)
            ? params.invoice[0]
            : params.invoice;
        if (invoice && state.load_stage === "done") {
            parsePaste(invoice);
            setParams({ invoice: undefined });
        }
    });

    const maxOnchain = createMemo(() => {
        return state.balance?.confirmed ?? 0n;
    });

    const maxLightning = createMemo(() => {
        return state.balance?.lightning ?? 0n;
    });

    const isMax = createMemo(() => {
        if (source() === "onchain") {
            return amountSats() === maxOnchain();
        }
    });

    // Rerun every time the source or amount changes to check for amount errors
    createEffect(() => {
        // Don't recompute if sending
        if (sending()) return;
        if (source() === "onchain" && maxOnchain() < amountSats()) {
            setError(i18n.t("send.error_low_balance"));
            return;
        }
        if (source() === "lightning" && maxLightning() < amountSats()) {
            setError(i18n.t("send.error_low_balance"));
            return;
        }
        if (
            source() === "lightning" &&
            !!invoice()?.amount_sats &&
            amountSats() !== invoice()?.amount_sats
        ) {
            setError(
                i18n.t("send.error_invoice_match", {
                    amount: invoice()?.amount_sats?.toLocaleString()
                })
            );
            return;
        }
        setError(undefined);
    });

    const [parsingDestination, setParsingDestination] = createSignal(false);

    function handleDestination(source: ParsedParams | undefined) {
        if (!source) return;
        setParsingDestination(true);
        try {
            if (source.address) setAddress(source.address);
            if (source.memo) setDescription(source.memo);

            if (source.invoice) {
                processInvoice(source as ParsedParams & { invoice: string });
            } else if (source.offer) {
                processOffer(source as ParsedParams & { offer: string });
            } else if (source.node_pubkey) {
                processNodePubkey(
                    source as ParsedParams & { node_pubkey: string }
                );
            } else {
                setAmountSats(source.amount_sats || 0n);
                if (source.amount_sats) setIsAmtEditable(false);
                setSource("onchain");
            }
            return source;
        } catch (e) {
            console.error("error", e);
        } finally {
            setParsingDestination(false);
        }
    }

    // A ParsedParams with an invoice in it
    function processInvoice(source: ParsedParams & { invoice: string }) {
        sw.decode_invoice(source.invoice!)
            .then((invoice) => {
                if (!invoice) return;
                if (invoice.expired || invoice.expire <= Date.now() / 1000) {
                    navigate("/search");
                    throw new Error(i18n.t("send.error_expired"));
                }

                if (invoice.amount_sats) {
                    setAmountSats(invoice.amount_sats);
                    setIsAmtEditable(false);
                }
                setInvoice(invoice);
                setSource("lightning");
            })
            .catch((e) => showToast(eify(e)));
    }

    // A ParsedParams with a BOLT12 offer in it
    function processOffer(source: ParsedParams & { offer: string }) {
        sw.decode_offer(source.offer)
            .then((decoded) => {
                if (decoded.is_expired) {
                    navigate("/search");
                    throw new Error(i18n.t("send.error_expired"));
                }
                const msat = decoded.amount?.amount?.bitcoin_msat;
                if (msat) {
                    setAmountSats(BigInt(Math.floor(msat / 1000)));
                    setIsAmtEditable(false);
                }
                if (decoded.description) setDescription(decoded.description);
                setOffer(source.offer);
                setSource("lightning");
            })
            .catch((e) => showToast(eify(e)));
    }

    // A ParsedParams with a node_pubkey in it
    function processNodePubkey(source: ParsedParams & { node_pubkey: string }) {
        setAmountSats(source.amount_sats || 0n);
        setNodePubkey(source.node_pubkey);
        setSource("lightning");
    }

    createEffect(() => {
        if (amountInput() === "") {
            setAmountSats(0n);
        } else {
            const parsed = BigInt(amountInput());
            if (!parsed) {
                setUnparsedAmount(true);
            }
            if (parsed > 0n) {
                setAmountSats(parsed);
                setUnparsedAmount(false);
            } else {
                setUnparsedAmount(true);
            }
        }
    });

    // If we got here from a scan or search
    onMount(() => {
        if (state.scan_result) {
            handleDestination(state.scan_result);
            actions.setScanResult(undefined);
        } else {
            navigate("/search");
        }
    });

    async function handleSend() {
        try {
            setSending(true);
            const bolt11 = invoice()?.bolt11;
            const sentDetails: Partial<SentDetails> = {};

            if (source() === "lightning" && invoice() && bolt11) {
                sentDetails.destination = bolt11;
                // If the invoice has sats use that, otherwise we pass the user-defined amount
                const payment = await sw.pay_invoice(
                    bolt11,
                    invoice()?.amount_sats ? undefined : amountSats()
                );
                sentDetails.amount = payment?.amount_sats;
                sentDetails.payment_hash = payment?.payment_hash;
                sentDetails.fee_estimate = payment?.fees_paid || 0;
            } else if (source() === "lightning" && offer()) {
                sentDetails.destination = offer();
                const payment = await sw.pay_offer(
                    offer()!,
                    isAmtEditable() ? amountSats() : undefined,
                    whatForInput()
                );
                sentDetails.amount = payment?.amount_sats;
                sentDetails.payment_hash = payment?.payment_hash;
                sentDetails.fee_estimate = payment?.fees_paid || 0;
            } else if (source() === "lightning" && nodePubkey()) {
                const payment = await sw.keysend(nodePubkey()!, amountSats());
                sentDetails.amount = payment?.amount_sats;
                sentDetails.payment_hash = payment?.payment_hash;
                sentDetails.fee_estimate = payment?.fees_paid || 0;
            } else if (source() === "onchain" && address()) {
                let txid;
                if (isMax()) {
                    // If we're trying to send the max amount, use the sweep method instead of regular send
                    txid = await sw.sweep_wallet(address()!);
                } else {
                    txid = await sw.send_to_address(address()!, amountSats());
                }
                sentDetails.amount = amountSats();
                sentDetails.destination = address();
                sentDetails.txid = txid;
            }
            if (sentDetails.payment_hash || sentDetails.txid) {
                setSentDetails(sentDetails as SentDetails);
                await vibrateSuccess();
            } else {
                console.error("failed to send: no payment hash or txid");
            }
        } catch (e) {
            const error = eify(e);
            setSentDetails({ failure_reason: error.message });
            console.error(e);
        } finally {
            setSending(false);
        }
    }

    const sendButtonDisabled = createMemo(() => {
        return (
            unparsedAmount() ||
            parsingDestination() ||
            sending() ||
            amountSats() == 0n ||
            amountSats() === undefined ||
            (source() === "onchain" && amountSats() < 546n) ||
            !!error()
        );
    });

    const lightningMethod = createMemo<MethodChoice>(() => {
        return {
            method: "lightning",
            maxAmountSats: maxLightning()
        };
    });

    const onchainMethod = createMemo<MethodChoice>(() => {
        return {
            method: "onchain",
            maxAmountSats: maxOnchain()
        };
    });

    const sendMethods = createMemo<MethodChoice[]>(() => {
        if (nodePubkey() || offer()) {
            return [lightningMethod()];
        }

        if (invoice() && address()) {
            return [lightningMethod(), onchainMethod()];
        }

        if (invoice()) {
            return [lightningMethod()];
        }

        if (address()) {
            return [onchainMethod()];
        }

        return [];
    });

    function setSourceFromMethod(method: MethodChoice) {
        if (method.method === "lightning") {
            setSource("lightning");
        } else if (method.method === "onchain") {
            setSource("onchain");
        }
    }

    const activeMethod = createMemo(() => {
        if (source() === "lightning") {
            return lightningMethod();
        } else if (source() === "onchain") {
            return onchainMethod();
        }
    });

    const location = useLocation();

    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <BackPop default="/" />
                <SuccessModal
                    confirmText={
                        sentDetails()?.amount
                            ? i18n.t("common.nice")
                            : i18n.t("common.home")
                    }
                    open={!!sentDetails()}
                    setOpen={(open: boolean) => {
                        if (!open) setSentDetails(undefined);
                    }}
                    onConfirm={() => {
                        setSentDetails(undefined);
                        const state = location.state as { previous?: string };
                        if (state?.previous) {
                            navigate("/");
                        } else {
                            navigate("/");
                        }
                    }}
                >
                    <Switch>
                        <Match when={sentDetails()?.failure_reason}>
                            <Failure
                                reason={
                                    sentDetails()?.failure_reason ||
                                    "Payment failed for an unknown reason"
                                }
                            />
                        </Match>
                        <Match when={true}>
                            <Show when={detailsId() && detailsKind()}>
                                <ActivityDetailsModal
                                    open={detailsOpen()}
                                    kind={detailsKind()}
                                    id={detailsId()}
                                    setOpen={setDetailsOpen}
                                />
                            </Show>
                            <MegaCheck />
                            <h1 class="mt-4 mb-2 w-full text-center text-2xl font-semibold md:text-3xl">
                                {sentDetails()?.amount
                                    ? source() === "onchain"
                                        ? i18n.t("send.payment_initiated")
                                        : i18n.t("send.payment_sent")
                                    : sentDetails()?.failure_reason}
                            </h1>
                            <div class="flex flex-col items-center gap-1">
                                <div class="text-xl">
                                    <AmountSats
                                        amountSats={sentDetails()?.amount}
                                        icon="minus"
                                    />
                                </div>
                                <div class="text-white/70">
                                    <AmountFiat
                                        amountSats={sentDetails()?.amount}
                                        denominationSize="sm"
                                    />
                                </div>
                            </div>
                            <hr class="w-16 bg-m-grey-400" />
                            <Show when={sentDetails()?.fee_estimate}>
                                <Fee amountSats={sentDetails()?.fee_estimate} />
                            </Show>
                            <p
                                class="cursor-pointer underline"
                                onClick={openDetailsModal}
                            >
                                {i18n.t("common.view_payment_details")}
                            </p>
                        </Match>
                    </Switch>
                </SuccessModal>
                <div class="flex flex-1 flex-col justify-between gap-2">
                    <Suspense fallback={<LoadingShimmer />}>
                        <DestinationShower
                            source={source()}
                            description={description()}
                            invoice={invoice()}
                            offer={offer()}
                            address={address()}
                            nodePubkey={nodePubkey()}
                        />
                    </Suspense>
                    <Show when={description()}>
                        <p class="text-center text-m-grey-350">
                            {description()}
                        </p>
                    </Show>
                    <div class="flex-1" />
                    {/* Need both these versions so that we make sure to get the right initial amount on load */}
                    <Show when={isAmtEditable()}>
                        <AmountEditable
                            initialAmountSats={amountSats()}
                            setAmountSats={setAmountInput}
                            onSubmit={() =>
                                sendButtonDisabled() ? undefined : handleSend()
                            }
                            activeMethod={activeMethod()}
                            methods={sendMethods()}
                            setChosenMethod={setSourceFromMethod}
                        />
                    </Show>
                    <Show when={!isAmtEditable()}>
                        <AmountEditable
                            initialAmountSats={amountSats()}
                            setAmountSats={setAmountInput}
                            frozenAmount={true}
                            onSubmit={() =>
                                sendButtonDisabled() ? undefined : handleSend()
                            }
                            activeMethod={activeMethod()}
                            methods={sendMethods()}
                            setChosenMethod={setSourceFromMethod}
                        />
                    </Show>
                    <Show when={error()}>
                        <InfoBox accent="red">
                            <p>{error()}</p>
                        </InfoBox>
                    </Show>
                    <div class="flex-1" />

                    <VStack>
                        <Show when={offer()}>
                            <form
                                onSubmit={async (e) => {
                                    e.preventDefault();
                                    if (!sendButtonDisabled()) {
                                        await handleSend();
                                    }
                                }}
                            >
                                <SimpleInput
                                    type="text"
                                    placeholder={i18n.t("send.what_for")}
                                    onInput={(e) =>
                                        setWhatForInput(e.currentTarget.value)
                                    }
                                    value={whatForInput()}
                                />
                            </form>
                        </Show>
                        <Button
                            disabled={sendButtonDisabled()}
                            intent="blue"
                            onClick={handleSend}
                            loading={sending()}
                        >
                            {sending()
                                ? i18n.t("send.sending")
                                : i18n.t("send.confirm_send")}
                        </Button>
                    </VStack>
                </div>
            </DefaultMain>
            <NavBar activeTab="send" />
        </MutinyWalletGuard>
    );
}

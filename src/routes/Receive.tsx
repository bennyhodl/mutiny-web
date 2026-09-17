import { useNavigate } from "@solidjs/router";
import { Link, Zap } from "lucide-solid";
import {
    createEffect,
    createMemo,
    createResource,
    createSignal,
    Match,
    onCleanup,
    Show,
    Switch
} from "solid-js";

import {
    ActivityDetailsModal,
    AmountEditable,
    AmountFiat,
    AmountSats,
    BackButton,
    BackLink,
    Button,
    DefaultMain,
    HackActivityType,
    Indicator,
    InfoBox,
    IntegratedQr,
    LargeHeader,
    MegaCheck,
    MutinyWalletGuard,
    NavBar,
    ReceiveWarnings,
    SharpButton,
    showToast,
    SimpleDialog,
    SimpleInput,
    StyledRadioGroup,
    SuccessModal,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { MutinyInvoice, OnChainTx } from "~/logic/types";
import { useMegaStore } from "~/state/megaStore";
import { eify, objectToSearchParams, vibrateSuccess } from "~/utils";

export type ReceiveFlavor = "lightning" | "onchain" | "bolt12";
type ReceiveState = "edit" | "show" | "paid";
type PaidState = "lightning_paid" | "onchain_paid";

function FlavorChooser(props: {
    flavor: ReceiveFlavor;
    setFlavor: (value: string) => void;
}) {
    const [methodChooserOpen, setMethodChooserOpen] = createSignal(false);
    const i18n = useI18n();

    const RECEIVE_FLAVORS = [
        {
            value: "lightning",
            label: i18n.t("receive.lightning_label"),
            caption: i18n.t("receive.lightning_caption")
        },
        {
            value: "onchain",
            label: i18n.t("receive.onchain_label"),
            caption: i18n.t("receive.onchain_caption")
        },
        {
            value: "bolt12",
            label: i18n.t("receive.bolt12_label"),
            caption: i18n.t("receive.bolt12_caption")
        }
    ];
    return (
        <>
            <SharpButton onClick={() => setMethodChooserOpen(true)}>
                {props.flavor === "onchain" ? (
                    <Link class="h-4 w-4" />
                ) : (
                    <Zap class="h-4 w-4" />
                )}
                {props.flavor === "lightning"
                    ? "Lightning"
                    : props.flavor === "onchain"
                      ? "On-chain"
                      : "BOLT12"}
            </SharpButton>
            <SimpleDialog
                title={i18n.t("receive.choose_payment_format")}
                open={methodChooserOpen()}
                setOpen={(open) => setMethodChooserOpen(open)}
            >
                <StyledRadioGroup
                    initialValue={props.flavor}
                    onValueChange={(flavor) => {
                        props.setFlavor(flavor);
                        setMethodChooserOpen(false);
                    }}
                    choices={RECEIVE_FLAVORS}
                    accent="white"
                    vertical
                    delayOnChange
                />
            </SimpleDialog>
        </>
    );
}

export function Receive() {
    const [_state, _actions, sw] = useMegaStore();
    const navigate = useNavigate();
    const i18n = useI18n();

    const [amount, setAmount] = createSignal<bigint>(0n);
    const [whatForInput, setWhatForInput] = createSignal("");

    const [receiveState, setReceiveState] = createSignal<ReceiveState>("edit");
    // We use these for displaying the QR
    const [receiveStrings, setReceiveStrings] = createSignal<{
        lightning?: string;
        onchain?: string;
        bolt12?: string;
    }>();
    // We use these for checking the payment status
    const [rawReceiveStrings, setRawReceiveStrings] = createSignal<{
        bolt11?: string;
        payment_hash?: string;
        address?: string;
        offer_id?: string;
    }>();

    // ldk-server has no "did this address get paid" call and lists no on-chain
    // payments, so we remember the on-chain balance when the address was shown
    // and treat any increase as our payment.
    const [onchainBefore, setOnchainBefore] = createSignal<bigint>(0n);

    // The data we get after a payment
    const [paymentTx, setPaymentTx] = createSignal<OnChainTx>();
    const [paymentInvoice, setPaymentInvoice] = createSignal<MutinyInvoice>();

    // The flavor of the receive
    const [flavor, setFlavor] = createSignal<ReceiveFlavor>("lightning");

    // loading state for the continue button
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<string>("");

    // Details Modal
    const [detailsOpen, setDetailsOpen] = createSignal(false);
    const [detailsKind, setDetailsKind] = createSignal<HackActivityType>();
    const [detailsId, setDetailsId] = createSignal<string>("");

    function clearAllButAmount() {
        setReceiveState("edit");
        setReceiveStrings(undefined);
        setRawReceiveStrings(undefined);
        setPaymentTx(undefined);
        setPaymentInvoice(undefined);
        setError("");
    }

    function clearAll() {
        clearAllButAmount();
        setAmount(0n);
        setFlavor("lightning");
        setWhatForInput("");
    }

    function openDetailsModal() {
        const paymentTxId =
            paidState() === "onchain_paid"
                ? paymentTx()?.txid
                : paymentInvoice()?.payment_hash;
        const kind = paidState() === "onchain_paid" ? "OnChain" : "Lightning";

        if (!paymentTxId) {
            console.warn("No id provided to openDetailsModal");
            return;
        }
        setDetailsId(paymentTxId);
        setDetailsKind(kind);
        setDetailsOpen(true);
    }

    async function getLightningReceiveString(amount: bigint) {
        const inv = await sw.create_invoice(amount, whatForInput().trim());
        setRawReceiveStrings({
            bolt11: inv.bolt11,
            payment_hash: inv.payment_hash
        });
        return `lightning:${inv.bolt11}`;
    }

    async function getOnchainReceiveString(amount?: bigint) {
        if (amount && amount < 546n) {
            throw new Error(i18n.t("receive.error_under_min_onchain"));
        }
        const raw = await sw.get_new_address();
        const address = raw.address;

        const balance = await sw.get_balance();
        setOnchainBefore(balance.confirmed + balance.unconfirmed);
        setRawReceiveStrings({ address });

        if (amount && amount > 0n) {
            const btc_amount = sw.convert_sats_to_btc(amount);
            const params = objectToSearchParams({
                amount: btc_amount.toString()
            });
            return `bitcoin:${address}?${params}`;
        } else {
            return `bitcoin:${address}`;
        }
    }

    async function getBolt12ReceiveString(amount: bigint) {
        const { offer, offer_id } = await sw.create_offer(
            amount,
            whatForInput().trim()
        );
        setRawReceiveStrings({ offer_id });
        return offer;
    }

    async function onSubmit(e: Event) {
        e.preventDefault();

        await getQr();
    }

    async function getQr() {
        setLoading(true);
        try {
            if (flavor() === "lightning") {
                const lightning = await getLightningReceiveString(amount());
                setReceiveStrings({ lightning });
            }

            if (flavor() === "onchain") {
                const onchain = await getOnchainReceiveString(amount());
                setReceiveStrings({ onchain });
            }

            if (flavor() === "bolt12") {
                const bolt12 = await getBolt12ReceiveString(amount());
                setReceiveStrings({ bolt12 });
            }

            if (
                !receiveStrings()?.lightning &&
                !receiveStrings()?.onchain &&
                !receiveStrings()?.bolt12
            ) {
                throw new Error(i18n.t("receive.receive_strings_error"));
            }

            if (!error()) {
                setReceiveState("show");
            }
        } catch (e) {
            console.error(e);
            showToast(eify(e));
        }

        setLoading(false);
    }

    const qrString = createMemo(() => {
        if (receiveState() === "show") {
            if (flavor() === "lightning") {
                return receiveStrings()?.lightning;
            } else if (flavor() === "onchain") {
                return receiveStrings()?.onchain;
            } else if (flavor() === "bolt12") {
                return receiveStrings()?.bolt12;
            }
        }
    });

    // Only copy the raw invoice string for lightning because the lightning prefix is not needed
    // for the onchain address we share the whole bip21 uri because it has more information
    const copyString = createMemo(() => {
        if (receiveState() === "show") {
            if (flavor() === "lightning") {
                return rawReceiveStrings()?.bolt11;
            } else if (flavor() === "onchain") {
                return receiveStrings()?.onchain;
            } else if (flavor() === "bolt12") {
                return receiveStrings()?.bolt12;
            }
        }
    });

    async function checkIfPaid(receiveStrings?: {
        bolt11?: string;
        payment_hash?: string;
        address?: string;
        offer_id?: string;
    }): Promise<PaidState | undefined> {
        if (!receiveStrings) return undefined;
        const { bolt11, payment_hash, address, offer_id } = receiveStrings;

        try {
            if (offer_id) {
                const invoice = await sw.find_offer_payment(offer_id);
                if (invoice) {
                    setReceiveState("paid");
                    setPaymentInvoice(invoice);
                    await vibrateSuccess();
                    return "lightning_paid";
                }
            }

            if (payment_hash) {
                const invoice = await sw.get_invoice_by_hash(payment_hash);
                if (invoice && invoice.paid) {
                    invoice.bolt11 = bolt11;
                    setReceiveState("paid");
                    setPaymentInvoice(invoice);
                    await vibrateSuccess();
                    return "lightning_paid";
                }
            }

            if (address) {
                const balance = await sw.get_balance();
                const now = balance.confirmed + balance.unconfirmed;
                if (now > onchainBefore()) {
                    setReceiveState("paid");
                    setPaymentTx({
                        txid: "",
                        received: Number(now - onchainBefore()),
                        sent: 0,
                        confirmed: balance.unconfirmed === 0n
                    });
                    await vibrateSuccess();
                    return "onchain_paid";
                }
            }
        } catch (e) {
            console.error(e);
        }
    }

    const [paidState, { refetch }] = createResource(
        rawReceiveStrings,
        checkIfPaid
    );

    createEffect(() => {
        const interval = setInterval(() => {
            if (receiveState() === "show") refetch();
        }, 1000); // Poll every second
        if (receiveState() !== "show") {
            clearInterval(interval);
        }
        onCleanup(() => {
            clearInterval(interval);
        });
    });

    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <Show when={receiveState() === "show"} fallback={<BackLink />}>
                    <BackButton
                        onClick={() => clearAllButAmount()}
                        title={i18n.t("receive.edit")}
                        showOnDesktop
                    />
                </Show>
                <LargeHeader
                    action={
                        receiveState() === "show" && (
                            <Indicator>{i18n.t("receive.checking")}</Indicator>
                        )
                    }
                >
                    {i18n.t("receive.receive_bitcoin")}
                </LargeHeader>
                <Switch>
                    <Match
                        when={!receiveStrings() || receiveState() === "edit"}
                    >
                        <div class="flex-1" />
                        <VStack>
                            <div class="mx-auto flex w-full max-w-[400px] flex-col items-center">
                                <AmountEditable
                                    initialAmountSats={amount() || "0"}
                                    setAmountSats={setAmount}
                                    onSubmit={getQr}
                                />
                                <FlavorChooser
                                    flavor={flavor()}
                                    setFlavor={setFlavor}
                                />
                            </div>
                            <ReceiveWarnings
                                amountSats={amount() || 0n}
                                flavor={
                                    flavor() === "onchain"
                                        ? "onchain"
                                        : "lightning"
                                }
                            />
                        </VStack>
                        <div class="flex-1" />
                        <VStack>
                            <form onSubmit={onSubmit}>
                                <SimpleInput
                                    type="text"
                                    value={whatForInput()}
                                    placeholder={i18n.t("receive.what_for")}
                                    onInput={(e) =>
                                        setWhatForInput(e.currentTarget.value)
                                    }
                                />
                            </form>
                            <Button
                                intent="green"
                                onClick={onSubmit}
                                loading={loading()}
                            >
                                {i18n.t("common.continue")}
                            </Button>
                        </VStack>
                    </Match>
                    <Match when={receiveStrings() && receiveState() === "show"}>
                        <Show when={error()}>
                            <InfoBox accent="red">
                                <p>{error()}</p>
                            </InfoBox>
                        </Show>
                        <Show when={flavor() === "onchain"}>
                            <InfoBox accent="blue">
                                {i18n.t("receive.warning_address_reuse")}
                            </InfoBox>
                        </Show>
                        <Show when={flavor() === "bolt12"}>
                            <InfoBox accent="blue">
                                {i18n.t("receive.bolt12_reusable")}
                            </InfoBox>
                        </Show>
                        <IntegratedQr
                            value={qrString() ?? ""}
                            copyString={copyString()}
                            amountSats={amount() ? amount().toString() : "0"}
                            kind={
                                flavor() === "onchain" ? "onchain" : "lightning"
                            }
                        />
                    </Match>
                    <Match when={receiveState() === "paid"}>
                        <SuccessModal
                            open={!!paidState()}
                            setOpen={(open: boolean) => {
                                if (!open) clearAll();
                            }}
                            onConfirm={() => {
                                clearAll();
                                navigate("/");
                            }}
                        >
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
                                {receiveState() === "paid" &&
                                paidState() === "lightning_paid"
                                    ? i18n.t("receive.payment_received")
                                    : i18n.t("receive.payment_initiated")}
                            </h1>
                            <div class="flex flex-col items-center gap-1">
                                <div class="text-xl">
                                    <AmountSats
                                        amountSats={
                                            paidState() === "lightning_paid"
                                                ? paymentInvoice()?.amount_sats
                                                : paymentTx()?.received
                                        }
                                        icon="plus"
                                    />
                                </div>
                                <div class="text-white/70">
                                    <AmountFiat
                                        amountSats={
                                            paidState() === "lightning_paid"
                                                ? paymentInvoice()?.amount_sats
                                                : paymentTx()?.received
                                        }
                                        denominationSize="sm"
                                    />
                                </div>
                            </div>
                            <hr class="w-16 bg-m-grey-400" />
                            <Show when={paidState() === "lightning_paid"}>
                                <p
                                    class="cursor-pointer underline"
                                    onClick={openDetailsModal}
                                >
                                    {i18n.t("common.view_payment_details")}
                                </p>
                            </Show>
                        </SuccessModal>
                    </Match>
                </Switch>
            </DefaultMain>
            <NavBar activeTab="receive" />
        </MutinyWalletGuard>
    );
}

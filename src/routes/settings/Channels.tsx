import { TextField } from "@kobalte/core";
import {
    createEffect,
    createMemo,
    createResource,
    createSignal,
    For,
    Match,
    Show,
    Suspense,
    Switch
} from "solid-js";

import {
    AmountSmall,
    BackLink,
    Button,
    Card,
    Collapser,
    ConfirmDialog,
    DefaultMain,
    ExternalLink,
    InfoBox,
    LargeHeader,
    MiniStringShower,
    MutinyWalletGuard,
    NavBar,
    NiceP,
    SettingsCard,
    showToast,
    SmallHeader,
    TinyText,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { MutinyChannel, MutinyPeer } from "~/logic/types";
import { useMegaStore } from "~/state/megaStore";
import { createDeepSignal, eify, mempoolTxUrl } from "~/utils";

export function BalanceBar(props: {
    inbound: number;
    reserve: number;
    outbound: number;
    hideHeader?: boolean;
}) {
    const i18n = useI18n();
    return (
        <VStack smallgap>
            <Show when={!props.hideHeader}>
                <div class="flex justify-between">
                    <SmallHeader>
                        {i18n.t("settings.channels.outbound")}
                    </SmallHeader>
                    <SmallHeader>
                        {i18n.t("settings.channels.reserve")}
                    </SmallHeader>
                    <SmallHeader>
                        {i18n.t("settings.channels.inbound")}
                    </SmallHeader>
                </div>
            </Show>
            <div class="flex w-full gap-1">
                <div
                    class="min-w-fit rounded-l-xl bg-m-green p-2"
                    style={{
                        "flex-grow": props.outbound || 1
                    }}
                >
                    <AmountSmall amountSats={props.outbound} />
                </div>
                <div
                    class="min-w-fit bg-m-grey-400 p-2"
                    style={{
                        "flex-grow": props.reserve
                    }}
                >
                    <AmountSmall amountSats={props.reserve} />
                </div>
                <div
                    class="min-w-fit rounded-r-xl bg-m-blue p-2"
                    style={{
                        "flex-grow": props.inbound || 1
                    }}
                >
                    <AmountSmall amountSats={props.inbound} />
                </div>
            </div>
        </VStack>
    );
}

function splitChannelNumbers(channel: MutinyChannel): {
    inbound: number;
    reserve: number;
    outbound: number;
} {
    return {
        inbound: Number(channel.inbound) || 0,
        reserve: Number(channel.reserve),
        outbound: Number(channel.balance)
    };
}

function SingleChannelItem(props: {
    channel: MutinyChannel;
    online: boolean;
    refetch: () => void;
}) {
    const i18n = useI18n();
    const [state, _actions, sw] = useMegaStore();
    const network = state.network;

    const [confirmOpen, setConfirmOpen] = createSignal(false);
    const [confirmLoading, setConfirmLoading] = createSignal(false);

    function confirmChannelClose() {
        setConfirmOpen(true);
    }

    async function closeChannel() {
        try {
            setConfirmLoading(true);
            const forceClose = !props.online;
            await sw.close_channel(props.channel, forceClose);
            props.refetch();
        } catch (e) {
            console.error(e);
            showToast(eify(e));
        } finally {
            setConfirmOpen(false);
            setConfirmLoading(false);
        }
    }

    const channelDetails = createMemo(() => splitChannelNumbers(props.channel));

    return (
        <Card>
            <VStack smallgap>
                <BalanceBar
                    inbound={channelDetails().inbound}
                    reserve={channelDetails().reserve}
                    outbound={channelDetails().outbound}
                    hideHeader
                />
                <div class="text-sm">
                    <MiniStringShower text={props.channel.peer} />
                </div>
                <Show when={!props.channel.is_ready}>
                    <TinyText>
                        {i18n.t("settings.channels.confirmations", {
                            have: props.channel.confirmations ?? 0,
                            need: props.channel.confirmations_required ?? 0
                        })}
                    </TinyText>
                </Show>
                <div class="flex justify-between text-sm">
                    <Show
                        when={network && network !== "regtest"}
                        fallback={<div />}
                    >
                        <ExternalLink
                            href={mempoolTxUrl(
                                props.channel.outpoint?.split(":")[0],
                                network
                            )}
                        >
                            {i18n.t("common.view_transaction")}
                        </ExternalLink>
                    </Show>
                    <button
                        onClick={confirmChannelClose}
                        class="self-center font-semibold text-m-red no-underline active:text-m-red/80"
                    >
                        {i18n.t("settings.channels.close_channel")}
                    </button>
                </div>
                <ConfirmDialog
                    loading={confirmLoading()}
                    open={confirmOpen()}
                    onConfirm={closeChannel}
                    onCancel={() => setConfirmOpen(false)}
                >
                    <Switch>
                        <Match when={!props.online}>
                            {i18n.t(
                                "settings.channels.force_close_channel_confirm"
                            )}
                        </Match>
                        <Match when={true}>
                            {i18n.t("settings.channels.close_channel_confirm")}
                        </Match>
                    </Switch>
                </ConfirmDialog>
            </VStack>
        </Card>
    );
}

function LiquidityMonitor() {
    const i18n = useI18n();
    const [state, _actions, sw] = useMegaStore();

    async function listChannels() {
        try {
            const channels = await sw.list_channels();

            let outbound = 0n;
            let inbound = 0n;
            let reserve = 0n;

            for (const channel of channels) {
                inbound = inbound + channel.inbound;
                reserve = reserve + channel.reserve;
                outbound = outbound + channel.balance;
            }

            return {
                inbound,
                reserve,
                outbound,
                channelCount: channels.length,
                online: channels.filter((c) => c.is_usable),
                offline: channels.filter((c) => !c.is_usable)
            };
        } catch (e) {
            console.error(e);
            return { inbound: 0, reserve: 0, outbound: 0, channelCount: 0 };
        }
    }

    const [channelInfo, { refetch }] = createResource(listChannels, {
        storage: createDeepSignal
    });

    createEffect(() => {
        // Refetch on the sync interval
        if (!state.is_syncing || state.events_version >= 0) {
            refetch();
        }
    });

    return (
        <VStack>
            <Switch>
                <Match
                    when={
                        channelInfo.latest && channelInfo.latest?.channelCount
                    }
                >
                    <Card>
                        <NiceP>
                            {i18n.t("settings.channels.have_channels")}{" "}
                            {channelInfo.latest?.channelCount}{" "}
                            {channelInfo.latest?.channelCount === 1
                                ? i18n.t("settings.channels.have_channels_one")
                                : i18n.t(
                                      "settings.channels.have_channels_many"
                                  )}
                        </NiceP>{" "}
                        <BalanceBar
                            inbound={Number(channelInfo.latest?.inbound) || 0}
                            reserve={Number(channelInfo.latest?.reserve) || 0}
                            outbound={Number(channelInfo.latest?.outbound) || 0}
                        />
                        <TinyText>
                            {i18n.t("settings.channels.inbound_outbound_tip")}
                        </TinyText>
                        <TinyText>
                            {i18n.t("settings.channels.reserve_tip")}
                        </TinyText>
                    </Card>
                    <Show when={channelInfo.latest?.online?.length}>
                        <SettingsCard>
                            <Collapser
                                title={i18n.t(
                                    "settings.channels.online_channels"
                                )}
                                activityLight="on"
                            >
                                <VStack>
                                    <For each={channelInfo.latest?.online}>
                                        {(channel) => (
                                            <SingleChannelItem
                                                channel={channel}
                                                online={true}
                                                refetch={refetch}
                                            />
                                        )}
                                    </For>
                                </VStack>
                            </Collapser>
                        </SettingsCard>
                    </Show>
                    <Show when={channelInfo.latest?.offline?.length}>
                        <SettingsCard>
                            <Collapser
                                title={i18n.t(
                                    "settings.channels.offline_channels"
                                )}
                                activityLight="off"
                            >
                                <VStack>
                                    <For each={channelInfo.latest?.offline}>
                                        {(channel) => (
                                            <SingleChannelItem
                                                channel={channel}
                                                online={false}
                                                refetch={refetch}
                                            />
                                        )}
                                    </For>
                                </VStack>
                            </Collapser>
                        </SettingsCard>
                    </Show>
                </Match>
                <Match when={true}>
                    <NiceP>{i18n.t("settings.channels.no_channels")}</NiceP>
                </Match>
            </Switch>
            <OpenChannel refetchChannels={refetch} />
        </VStack>
    );
}

function OpenChannel(props: { refetchChannels: () => void }) {
    const i18n = useI18n();
    const [state, _actions, sw] = useMegaStore();

    const [error, setError] = createSignal<Error>();
    const [loading, setLoading] = createSignal(false);
    const [amount, setAmount] = createSignal("");
    const [peer, setPeer] = createSignal("");
    const [opened, setOpened] = createSignal<string>();

    const onSubmit = async (e: SubmitEvent) => {
        e.preventDefault();
        setError(undefined);
        setOpened(undefined);
        setLoading(true);
        try {
            const [pubkey, address] = peer().trim().split("@");
            if (!pubkey || !address) {
                throw new Error(i18n.t("settings.channels.open.expect_uri"));
            }
            const sats = BigInt(amount());
            if (sats < 20_000n) {
                throw new Error(i18n.t("settings.channels.open.too_small"));
            }
            if (sats > (state.balance?.confirmed ?? 0n)) {
                throw new Error(i18n.t("send.error_low_balance"));
            }
            const id = await sw.open_channel(pubkey, address, sats);
            setOpened(id);
            props.refetchChannels();
            setAmount("");
            setPeer("");
        } catch (e) {
            setError(eify(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <SettingsCard title={i18n.t("settings.channels.open.title")}>
            <form class="flex flex-col gap-4 p-4" onSubmit={onSubmit}>
                <TextField.Root
                    value={peer()}
                    onChange={setPeer}
                    class="flex flex-col gap-2"
                >
                    <TextField.Label class="text-sm font-semibold uppercase">
                        {i18n.t("settings.channels.open.peer")}
                    </TextField.Label>
                    <TextField.Input
                        class="w-full rounded-lg p-2 text-black"
                        placeholder="pubkey@host:port"
                    />
                </TextField.Root>
                <TextField.Root
                    value={amount()}
                    onChange={setAmount}
                    class="flex flex-col gap-2"
                >
                    <TextField.Label class="text-sm font-semibold uppercase">
                        {i18n.t("settings.channels.open.amount")}
                    </TextField.Label>
                    <TextField.Input
                        type="number"
                        class="w-full rounded-lg p-2 text-black"
                    />
                </TextField.Root>
                <Button
                    layout="small"
                    type="submit"
                    loading={loading()}
                    disabled={!peer() || !amount()}
                >
                    {i18n.t("settings.channels.open.button")}
                </Button>
                <Show when={opened()}>
                    <InfoBox accent="green">
                        {i18n.t("settings.channels.open.success")}
                    </InfoBox>
                </Show>
                <Show when={error()}>
                    <InfoBox accent="red">{error()?.message}</InfoBox>
                </Show>
            </form>
        </SettingsCard>
    );
}

function PeerItem(props: { peer: MutinyPeer; refetch: () => void }) {
    const i18n = useI18n();
    const [_state, _actions, sw] = useMegaStore();

    async function disconnect() {
        try {
            await sw.disconnect_peer(props.peer.pubkey);
            props.refetch();
        } catch (e) {
            showToast(eify(e));
        }
    }

    return (
        <div class="flex flex-col gap-2 px-4 py-2">
            <div class="flex items-center gap-2">
                <div
                    class="h-2 w-2 rounded-full"
                    classList={{
                        "bg-m-green": props.peer.is_connected,
                        "bg-m-grey-400": !props.peer.is_connected
                    }}
                />
                <div class="min-w-0 flex-1 text-sm">
                    <MiniStringShower
                        text={props.peer.connection_string ?? props.peer.pubkey}
                    />
                </div>
            </div>
            <button
                class="self-end text-sm font-semibold text-m-red"
                onClick={disconnect}
            >
                {i18n.t("settings.channels.peers.disconnect")}
            </button>
        </div>
    );
}

export function PeersList() {
    const i18n = useI18n();
    const [_state, _actions, sw] = useMegaStore();
    const [value, setValue] = createSignal("");
    const [loading, setLoading] = createSignal(false);

    const [peers, { refetch }] = createResource(async () => {
        try {
            return await sw.list_peers();
        } catch (e) {
            console.error(e);
            return [] as MutinyPeer[];
        }
    });

    const onSubmit = async (e: SubmitEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            await sw.connect_to_peer(value().trim());
            setValue("");
            refetch();
        } catch (err) {
            showToast(eify(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <SettingsCard title={i18n.t("settings.channels.peers.title")}>
            <Suspense>
                <For
                    each={peers.latest}
                    fallback={
                        <TinyText>
                            <div class="px-4 py-2">
                                {i18n.t("settings.channels.peers.none")}
                            </div>
                        </TinyText>
                    }
                >
                    {(peer) => <PeerItem peer={peer} refetch={refetch} />}
                </For>
            </Suspense>
            <form class="flex flex-col gap-4 p-4" onSubmit={onSubmit}>
                <TextField.Root
                    value={value()}
                    onChange={setValue}
                    class="flex flex-col gap-2"
                >
                    <TextField.Label class="text-sm font-semibold uppercase">
                        {i18n.t("settings.channels.peers.connect")}
                    </TextField.Label>
                    <TextField.Input
                        class="w-full rounded-lg p-2 text-black"
                        placeholder="pubkey@host:port"
                    />
                </TextField.Root>
                <Button
                    layout="small"
                    type="submit"
                    loading={loading()}
                    disabled={!value()}
                >
                    {i18n.t("settings.channels.peers.connect_button")}
                </Button>
            </form>
        </SettingsCard>
    );
}

export function Channels() {
    const i18n = useI18n();
    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <BackLink href="/settings" title={i18n.t("settings.header")} />
                <LargeHeader>{i18n.t("settings.channels.title")}</LargeHeader>
                <Suspense>
                    <LiquidityMonitor />
                </Suspense>
                <Suspense>
                    <PeersList />
                </Suspense>
            </DefaultMain>
            <NavBar activeTab="settings" />
        </MutinyWalletGuard>
    );
}

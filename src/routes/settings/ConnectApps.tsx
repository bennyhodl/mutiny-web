import { createResource, For, Show, Suspense } from "solid-js";

import {
    BackLink,
    CopyButton,
    DefaultMain,
    LargeHeader,
    MutinyWalletGuard,
    NavBar,
    NiceP,
    QrCode,
    SettingsCard,
    TinyText,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { connections } from "~/logic/ldkApi";

function Shareable(props: { value: string }) {
    return (
        <div class="flex flex-col items-center gap-3 p-4">
            <div class="w-full max-w-[256px] rounded-xl bg-white p-3">
                <QrCode
                    value={props.value}
                    class="[&>svg]:h-auto [&>svg]:w-full"
                />
            </div>
            <p class="w-full max-w-[256px] truncate font-mono text-sm text-m-grey-400">
                {props.value}
            </p>
            <CopyButton text={props.value} />
        </div>
    );
}

function Off(props: { env: string }) {
    const i18n = useI18n();
    return (
        <p class="p-4 text-sm text-m-grey-400">
            {i18n.t("settings.connect_apps.off", { env: props.env })}
        </p>
    );
}

/** How outside apps such as Zaprite pay this node. Both can only receive. */
export function ConnectApps() {
    const i18n = useI18n();
    const [data] = createResource(connections);

    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <BackLink href="/settings" title={i18n.t("settings.header")} />
                <LargeHeader>
                    {i18n.t("settings.connect_apps.title")}
                </LargeHeader>
                <VStack>
                    <NiceP>{i18n.t("settings.connect_apps.description")}</NiceP>
                    <Suspense>
                        <Show when={data.latest}>
                            {(c) => (
                                <>
                                    <SettingsCard
                                        title={i18n.t(
                                            "settings.connect_apps.nwc"
                                        )}
                                    >
                                        <Show
                                            when={c().nwc}
                                            fallback={
                                                <Off env="WALLET_NWC_RELAY" />
                                            }
                                        >
                                            {(nwc) => (
                                                <>
                                                    <Shareable
                                                        value={nwc().uri}
                                                    />
                                                    <div class="flex flex-wrap gap-2 px-4">
                                                        <For
                                                            each={nwc().methods}
                                                        >
                                                            {(m) => (
                                                                <span class="rounded bg-m-grey-750 px-2 py-0.5 font-mono text-xs">
                                                                    {m}
                                                                </span>
                                                            )}
                                                        </For>
                                                    </div>
                                                    <div class="flex flex-col gap-1 p-4">
                                                        <TinyText>
                                                            {i18n.t(
                                                                "settings.connect_apps.relay"
                                                            )}{" "}
                                                            {nwc().relay}
                                                        </TinyText>
                                                        <TinyText>
                                                            {i18n.t(
                                                                "settings.connect_apps.nwc_secret"
                                                            )}
                                                        </TinyText>
                                                    </div>
                                                </>
                                            )}
                                        </Show>
                                    </SettingsCard>
                                    <SettingsCard
                                        title={i18n.t(
                                            "settings.connect_apps.lightning_address"
                                        )}
                                    >
                                        <Show
                                            when={c().lightning_address}
                                            fallback={
                                                <Off env="WALLET_LNURL_USERNAME" />
                                            }
                                        >
                                            {(address) => (
                                                <Shareable value={address()} />
                                            )}
                                        </Show>
                                    </SettingsCard>
                                </>
                            )}
                        </Show>
                    </Suspense>
                </VStack>
            </DefaultMain>
            <NavBar activeTab="settings" />
        </MutinyWalletGuard>
    );
}

import { createResource, Show, Suspense } from "solid-js";

import {
    BackPop,
    Button,
    DefaultMain,
    KeyValue,
    LargeHeader,
    MiniStringShower,
    MutinyWalletGuard,
    NavBar,
    SettingsCard,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { useMegaStore } from "~/state/megaStore";
import { prettyPrintTime } from "~/utils";

/** Facts about the ldk-server node this wallet drives. */
export function Node() {
    const i18n = useI18n();
    const [state, actions, sw] = useMegaStore();

    const [info] = createResource(async () => {
        try {
            return await sw.get_node_info();
        } catch (e) {
            console.error(e);
            return state.node_info;
        }
    });

    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <BackPop default="/settings" />
                <LargeHeader>{i18n.t("settings.node.title")}</LargeHeader>
                <VStack>
                    <Suspense>
                        <Show when={info.latest}>
                            <SettingsCard>
                                <ul class="flex flex-col gap-4 p-4">
                                    <KeyValue
                                        key={i18n.t("settings.node.alias")}
                                    >
                                        {info.latest?.alias ?? "-"}
                                    </KeyValue>
                                    <KeyValue
                                        key={i18n.t("settings.node.network")}
                                    >
                                        {info.latest?.network}
                                    </KeyValue>
                                    <KeyValue
                                        key={i18n.t("settings.node.node_id")}
                                    >
                                        <MiniStringShower
                                            text={info.latest?.node_id ?? ""}
                                        />
                                    </KeyValue>
                                    <Show when={info.latest?.node_uris?.length}>
                                        <KeyValue
                                            key={i18n.t("settings.node.uri")}
                                        >
                                            <MiniStringShower
                                                text={
                                                    info.latest?.node_uris[0] ??
                                                    ""
                                                }
                                            />
                                        </KeyValue>
                                    </Show>
                                    <KeyValue
                                        key={i18n.t(
                                            "settings.node.block_height"
                                        )}
                                    >
                                        {info.latest?.block_height ?? "-"}
                                    </KeyValue>
                                    <Show when={info.latest?.last_onchain_sync}>
                                        <KeyValue
                                            key={i18n.t(
                                                "settings.node.last_onchain_sync"
                                            )}
                                        >
                                            {prettyPrintTime(
                                                info.latest!.last_onchain_sync!
                                            )}
                                        </KeyValue>
                                    </Show>
                                    <Show
                                        when={info.latest?.last_lightning_sync}
                                    >
                                        <KeyValue
                                            key={i18n.t(
                                                "settings.node.last_lightning_sync"
                                            )}
                                        >
                                            {prettyPrintTime(
                                                info.latest!
                                                    .last_lightning_sync!
                                            )}
                                        </KeyValue>
                                    </Show>
                                    <KeyValue
                                        key={i18n.t("settings.node.events")}
                                    >
                                        {state.events_connected
                                            ? i18n.t("settings.node.connected")
                                            : i18n.t(
                                                  "settings.node.disconnected"
                                              )}
                                    </KeyValue>
                                </ul>
                            </SettingsCard>
                        </Show>
                    </Suspense>
                    <Show when={state.auth_enabled}>
                        <Button intent="red" onClick={() => actions.logout()}>
                            {i18n.t("settings.node.sign_out")}
                        </Button>
                    </Show>
                </VStack>
            </DefaultMain>
            <NavBar activeTab="settings" />
        </MutinyWalletGuard>
    );
}

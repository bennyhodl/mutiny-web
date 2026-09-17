import { useNavigate } from "@solidjs/router";
import { Link, Plus, Search, Zap } from "lucide-solid";
import {
    createEffect,
    createResource,
    createSignal,
    For,
    Match,
    Show,
    Suspense,
    Switch
} from "solid-js";

import {
    ActivityDetailsModal,
    ButtonCard,
    LoadingShimmer,
    NiceP
} from "~/components";
import { useI18n } from "~/i18n/context";
import { ActivityItem } from "~/logic/types";
import { useMegaStore } from "~/state/megaStore";
import { createDeepSignal, timeAgo } from "~/utils";

import { GenericItem } from "./GenericItem";

export type HackActivityType = "Lightning" | "OnChain";

export type IActivityItem = ActivityItem;

export function UnifiedActivityItem(props: {
    item: IActivityItem;
    onClick: (id: string, kind: HackActivityType) => void;
}) {
    const click = () => {
        props.onClick(props.item.id, props.item.kind);
    };

    const verb = () => {
        if (props.item.status === "failed") return "failed to send";
        if (props.item.status === "pending") {
            return props.item.inbound ? "is sending" : "are sending";
        }
        return props.item.inbound ? "paid" : "sent";
    };

    const primaryName = () => (props.item.inbound ? "Someone" : "You");
    const secondaryName = () => (props.item.inbound ? "you" : "someone");

    const message = () => {
        if (props.item.kind === "OnChain") {
            return props.item.confirmed === false ? "Unconfirmed" : undefined;
        }
        if (props.item.method !== "Lightning") return props.item.method;
        return undefined;
    };

    return (
        <div class="pt-3 first-of-type:pt-0">
            <GenericItem
                icon={
                    props.item.kind === "OnChain" ? (
                        <Link class="h-6 w-6 text-m-grey-350" />
                    ) : (
                        <Zap class="h-6 w-6 text-m-grey-350" />
                    )
                }
                primaryOnClick={click}
                amountOnClick={click}
                primaryName={primaryName()}
                genericAvatar={true}
                verb={verb()}
                message={message()}
                secondaryName={secondaryName()}
                amount={
                    props.item.amount_sats
                        ? BigInt(props.item.amount_sats || 0)
                        : undefined
                }
                date={timeAgo(props.item.last_updated)}
                accent={
                    props.item.inbound && props.item.status === "paid"
                        ? "green"
                        : undefined
                }
                shouldSpinny={props.item.status === "pending"}
            />
        </div>
    );
}

export function CombinedActivity() {
    const [state, _actions, sw] = useMegaStore();
    const i18n = useI18n();

    const [detailsOpen, setDetailsOpen] = createSignal(false);
    const [detailsKind, setDetailsKind] = createSignal<HackActivityType>();
    const [detailsId, setDetailsId] = createSignal("");
    const navigate = useNavigate();

    function openDetailsModal(id: string, kind: HackActivityType) {
        if (!id) {
            console.warn("No id provided to openDetailsModal");
            return;
        }

        setDetailsId(id);
        setDetailsKind(kind);
        setDetailsOpen(true);
    }

    async function fetchActivity() {
        try {
            return await sw.get_activity(50);
        } catch (e) {
            console.error(e);
            return [] as IActivityItem[];
        }
    }

    const [activity, { refetch }] = createResource(fetchActivity, {
        storage: createDeepSignal
    });

    createEffect(() => {
        // Should re-run after every sync and every node event
        if (!state.is_syncing || state.events_version >= 0) {
            refetch();
        }
    });

    return (
        <>
            <Show when={detailsId() && detailsKind()}>
                <ActivityDetailsModal
                    open={detailsOpen()}
                    kind={detailsKind()}
                    id={detailsId()}
                    setOpen={setDetailsOpen}
                />
            </Show>
            <Suspense fallback={<LoadingShimmer />}>
                <Switch>
                    <Match when={activity.latest?.length === 0}>
                        <ButtonCard onClick={() => navigate("/receive")}>
                            <div class="flex items-center gap-2">
                                <Plus class="inline-block text-m-red" />
                                <NiceP>{i18n.t("home.receive")}</NiceP>
                            </div>
                        </ButtonCard>
                        <ButtonCard onClick={() => navigate("/search")}>
                            <div class="flex items-center gap-2">
                                <Search class="inline-block text-m-red" />
                                <NiceP>{i18n.t("home.find")}</NiceP>
                            </div>
                        </ButtonCard>
                    </Match>
                    <Match
                        when={activity.latest && activity.latest!.length >= 0}
                    >
                        <div class="flex w-full flex-col divide-y divide-m-grey-800 overflow-x-clip">
                            <For each={activity.latest}>
                                {(activityItem) => (
                                    <UnifiedActivityItem
                                        item={activityItem}
                                        onClick={openDetailsModal}
                                    />
                                )}
                            </For>
                        </div>
                    </Match>
                </Switch>
            </Suspense>
        </>
    );
}

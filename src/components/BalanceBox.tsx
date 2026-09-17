import { useNavigate } from "@solidjs/router";
import { createMemo, Show, Suspense } from "solid-js";

import {
    AmountFiat,
    AmountSats,
    FancyCard,
    Indicator,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { useMegaStore } from "~/state/megaStore";

export function LoadingShimmer(props: { center?: boolean; small?: boolean }) {
    return (
        <div class="flex animate-pulse flex-col gap-2">
            <h1
                class="text-4xl font-light"
                classList={{ "flex justify-center": props.center }}
            >
                <div
                    class="rounded bg-neutral-700"
                    classList={{
                        "h-10 w-48": !props.small,
                        "h-4 w-32": props.small
                    }}
                />
            </h1>
            <Show when={!props.small}>
                <h2
                    class="text-xl font-light text-white/70"
                    classList={{ "flex justify-center": props.center }}
                >
                    <div class="h-7 w-32 rounded bg-neutral-700" />
                </h2>
            </Show>
        </div>
    );
}

export function BalanceBox(props: { loading?: boolean }) {
    const [state, _actions] = useMegaStore();
    const navigate = useNavigate();
    const i18n = useI18n();

    const totalOnchain = createMemo(
        () =>
            (state.balance?.confirmed || 0n) +
            (state.balance?.unconfirmed || 0n) +
            (state.balance?.force_close || 0n)
    );

    const hasPending = createMemo(
        () =>
            (state.balance?.unconfirmed || 0n) > 0n ||
            (state.balance?.force_close || 0n) > 0n
    );

    return (
        <VStack>
            <FancyCard>
                <Show when={!props.loading} fallback={<LoadingShimmer />}>
                    <button
                        class="flex w-full flex-col gap-1 text-left"
                        onClick={() => navigate("/settings/channels")}
                    >
                        <div class="text-2xl">
                            <AmountSats
                                amountSats={state.balance?.lightning || 0}
                                icon="lightning"
                                denominationSize="lg"
                            />
                        </div>
                        <div class="text-lg text-white/70">
                            <Suspense>
                                <AmountFiat
                                    amountSats={state.balance?.lightning || 0}
                                    denominationSize="sm"
                                />
                            </Suspense>
                        </div>
                    </button>
                </Show>
                <hr class="my-2 border-m-grey-750" />
                <Show when={!props.loading} fallback={<LoadingShimmer />}>
                    <div class="flex justify-between">
                        <div class="flex flex-col gap-1">
                            <div class="text-2xl">
                                <AmountSats
                                    amountSats={totalOnchain()}
                                    icon="chain"
                                    denominationSize="lg"
                                />
                            </div>
                            <div class="text-lg text-white/70">
                                <Suspense>
                                    <AmountFiat
                                        amountSats={totalOnchain()}
                                        denominationSize="sm"
                                    />
                                </Suspense>
                            </div>
                        </div>
                        <div class="flex flex-col items-end justify-between gap-1">
                            <Show when={hasPending()}>
                                <Indicator>
                                    {i18n.t("common.pending")}
                                </Indicator>
                            </Show>
                        </div>
                    </div>
                </Show>
            </FancyCard>
        </VStack>
    );
}

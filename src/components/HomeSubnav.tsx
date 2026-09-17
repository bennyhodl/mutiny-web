import { Show, Suspense } from "solid-js";

import {
    BalanceBox,
    CombinedActivity,
    LoadingShimmer,
    VStack
} from "~/components";
import { useMegaStore } from "~/state/megaStore";

export function HomeSubnav() {
    const [state] = useMegaStore();

    return (
        <>
            <BalanceBox loading={state.wallet_loading} />
            <VStack>
                <Suspense>
                    <Show
                        when={!state.wallet_loading}
                        fallback={<LoadingShimmer />}
                    >
                        <CombinedActivity />
                    </Show>
                </Suspense>
            </VStack>
            {/* spacer just so we can always scroll above the fab */}
            <div class="h-16" />
        </>
    );
}

import { useNavigate } from "@solidjs/router";
import { Server } from "lucide-solid";
import { Show } from "solid-js";

import {
    Circle,
    DefaultMain,
    HomeBalance,
    HomeSubnav,
    LoadingIndicator,
    NavBar,
    ReloadPrompt
} from "~/components";
import { Fab } from "~/components/Fab";
import { useMegaStore } from "~/state/megaStore";

export function WalletHeader() {
    const navigate = useNavigate();

    return (
        <header class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4">
            <Circle
                onClick={() =>
                    navigate("/settings/node", { state: { previous: "/" } })
                }
            >
                <Server class="h-6 w-6" />
            </Circle>
            <HomeBalance />
            <Circle onClick={() => navigate("/settings")}>
                <img
                    src="/mutiny-pixel-m.png"
                    alt="mutiny"
                    width={"32px"}
                    height={"32px"}
                    style={{
                        "image-rendering": "pixelated"
                    }}
                />
            </Circle>
        </header>
    );
}

export function Main() {
    const [state] = useMegaStore();

    const navigate = useNavigate();

    return (
        <DefaultMain>
            <Show when={state.load_stage !== "done"}>
                <WalletHeader />
                <div class="flex-1" />

                <LoadingIndicator />
                <div class="flex-1" />
            </Show>
            <Show when={state.load_stage === "done"}>
                <WalletHeader />
                <ReloadPrompt />
                <HomeSubnav />
            </Show>

            <Fab
                onSearch={() => navigate("/search")}
                onScan={() => navigate("/scanner")}
            />

            <NavBar activeTab="home" />
        </DefaultMain>
    );
}

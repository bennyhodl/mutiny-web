import { Clipboard } from "@capacitor/clipboard";
import { Capacitor } from "@capacitor/core";
import { A, createAsync, useNavigate } from "@solidjs/router";
import { LucideClipboard, Scan, X } from "lucide-solid";
import { createEffect, createSignal, onMount, Show, Suspense } from "solid-js";

import { NavBar, NiceP, showToast, VStack } from "~/components";
import {
    BackLink,
    Button,
    DefaultMain,
    MutinyWalletGuard
} from "~/components/layout";
import { useI18n } from "~/i18n/context";
import { useMegaStore } from "~/state/megaStore";
import { debounce } from "~/utils";

/** Type or paste a destination: invoice, offer, address, BIP21 or node id. */
export function Search() {
    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <div class="flex items-center justify-between">
                    <BackLink />
                    <A
                        class="rounded-lg p-2 hover:bg-white/5 active:bg-m-blue md:hidden"
                        href="/scanner"
                    >
                        <Scan class="h-6 w-6" />
                    </A>{" "}
                </div>
                <Suspense>
                    <ActualSearch />
                </Suspense>
            </DefaultMain>
            <NavBar activeTab="send" />
        </MutinyWalletGuard>
    );
}

function ActualSearch() {
    const [searchValue, setSearchValue] = createSignal("");
    const [debouncedSearchValue, setDebouncedSearchValue] = createSignal("");
    const [_state, actions] = useMegaStore();
    const navigate = useNavigate();
    const i18n = useI18n();

    const trigger = debounce((message: string) => {
        setDebouncedSearchValue(message);
    }, 250);

    createEffect(() => {
        trigger(searchValue());
    });

    const sendable = createAsync<boolean>(async () => {
        const text = debouncedSearchValue().trim();
        if (text.length < 6) {
            return false;
        }
        let ok = false;
        await actions.handleIncomingString(
            text,
            () => {
                ok = false;
            },
            () => {
                ok = true;
            }
        );
        return ok;
    });

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

    async function handleContinue() {
        await parsePaste(debouncedSearchValue().trim());
    }

    async function handlePaste() {
        try {
            let text;

            if (Capacitor.isNativePlatform()) {
                const { value } = await Clipboard.read();
                text = value;
            } else {
                if (!navigator.clipboard.readText) {
                    return showToast(new Error(i18n.t("send.error_clipboard")));
                }
                text = await navigator.clipboard.readText();
            }

            const trimText = text.trim();
            setSearchValue(trimText);
            await parsePaste(trimText);
        } catch (e) {
            console.error(e);
        }
    }

    let searchInputRef!: HTMLInputElement;

    onMount(() => {
        searchInputRef.focus();
    });

    return (
        <>
            <div class="relative">
                <input
                    class="w-full rounded-lg bg-m-grey-750 p-2 placeholder-m-grey-400 disabled:text-m-grey-400"
                    type="text"
                    value={searchValue()}
                    onInput={(e) => setSearchValue(e.currentTarget.value)}
                    placeholder={i18n.t("send.search.placeholder") + " ..."}
                    autofocus
                    autocomplete="off"
                    autocorrect="off"
                    ref={(el) => (searchInputRef = el)}
                />
                <Show when={!searchValue()}>
                    <button
                        class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 py-1 pr-4"
                        onClick={handlePaste}
                    >
                        <LucideClipboard class="h-4 w-4" />
                        {i18n.t("send.search.paste")}
                    </button>
                </Show>
                <Show when={!!searchValue()}>
                    <button
                        class="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 rounded-full bg-m-grey-800 px-1 py-1"
                        onClick={() => setSearchValue("")}
                    >
                        <X class="h-4 w-4" />
                    </button>
                </Show>
            </div>
            <Suspense>
                <div class="flex w-full flex-0">
                    <Show when={sendable()}>
                        <Button intent="green" onClick={handleContinue}>
                            {i18n.t("common.continue")}
                        </Button>
                    </Show>
                </div>
                <Show when={!sendable()}>
                    <VStack>
                        <NiceP>{i18n.t("send.search.help")}</NiceP>
                    </VStack>
                </Show>
            </Suspense>
        </>
    );
}

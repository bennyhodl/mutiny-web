// Inspired by https://github.com/solidjs/solid-realworld/blob/main/src/store/index.js
import { useNavigate, useSearchParams } from "@solidjs/router";
import {
    createContext,
    onCleanup,
    onMount,
    ParentComponent,
    useContext
} from "solid-js";
import { createStore } from "solid-js/store";

import { showToast } from "~/components";
import { eventToToast, onchainChangeToast } from "~/logic/eventToast";
import {
    authLogin,
    authLogout,
    authMe,
    subscribeEvents,
    UNAUTHENTICATED_EVENT,
    walletConfig
} from "~/logic/ldkApi";
import { Network } from "~/logic/mutinyWalletSetup";
import { loginWithPasskey } from "~/logic/passkeys";
import { MutinyBalance, NodeInfo } from "~/logic/types";
import { ParsedParams, toParsedParams } from "~/logic/waila";
import * as wallet from "~/logic/wallet";
import { BTC_OPTION, Currency, eify, USD_OPTION } from "~/utils";

type LoadStage = "fresh" | "checking_auth" | "login" | "setup" | "done";

export type WalletWorker = typeof wallet;

const SYNC_INTERVAL_MS = 5 * 1000;

export const makeMegaStoreContext = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const sw: WalletWorker = wallet;

    const [state, setState] = createStore({
        network: undefined as Network | undefined,
        node_info: undefined as NodeInfo | undefined,
        scan_result: undefined as ParsedParams | undefined,
        price: 0,
        fiat: localStorage.getItem("fiat_currency")
            ? (JSON.parse(localStorage.getItem("fiat_currency")!) as Currency)
            : USD_OPTION,
        balance: undefined as Partial<MutinyBalance> | undefined,
        last_sync: undefined as number | undefined,
        price_sync_backoff_multiple: 1,
        is_syncing: false,
        wallet_loading: true,
        setup_error: undefined as Error | undefined,
        is_pwa: window.matchMedia("(display-mode: standalone)").matches,
        auth_enabled: false,
        has_passkeys: false,
        load_stage: "fresh" as LoadStage,
        lang: localStorage.getItem("i18nexLng") || undefined,
        preferredInvoiceType: "unified" as "unified" | "lightning" | "onchain",
        balanceView: localStorage.getItem("balanceView") || "sats",
        /** Bumped on every node event so lists can refetch. */
        events_version: 0,
        events_connected: false
    });

    let syncInterval: ReturnType<typeof setInterval> | undefined;
    let priceInterval: ReturnType<typeof setInterval> | undefined;
    let unsubscribeEvents: (() => void) | undefined;

    const actions = {
        async preSetup(): Promise<boolean> {
            try {
                if (state.setup_error) {
                    throw state.setup_error;
                }

                setState({
                    wallet_loading: true,
                    load_stage: "checking_auth"
                });

                const auth = await authMe();
                setState({
                    auth_enabled: auth.auth_enabled,
                    has_passkeys: auth.has_passkeys
                });

                if (!auth.logged_in) {
                    setState({ load_stage: "login" });
                    navigate("/setup");
                    return false;
                }
                return true;
            } catch (e) {
                console.error(e);
                setState({ setup_error: eify(e) });
                return false;
            }
        },
        async login(password: string): Promise<void> {
            await authLogin(password);
            await actions.setup();
        },
        async loginWithPasskey(): Promise<void> {
            await loginWithPasskey();
            await actions.setup();
        },
        setHasPasskeys(has_passkeys: boolean) {
            setState({ has_passkeys });
        },
        async logout(): Promise<void> {
            actions.teardown();
            await authLogout();
            setState({
                load_stage: "login",
                wallet_loading: true,
                balance: undefined,
                node_info: undefined
            });
            navigate("/setup");
        },
        async setup(): Promise<void> {
            try {
                setState({ load_stage: "setup", wallet_loading: true });

                const config = await walletConfig();
                const node_info = await sw.get_node_info();
                const balance = await sw.get_balance();

                setState({
                    wallet_loading: false,
                    load_stage: "done",
                    balance,
                    node_info,
                    network: config.network as Network
                });

                console.log("Wallet connected to", node_info.node_id);

                await actions.postSetup();
            } catch (e) {
                console.error(e);
                setState({ setup_error: eify(e) });
            }
        },
        async postSetup(): Promise<void> {
            actions.teardown();

            unsubscribeEvents = subscribeEvents(
                (event) => {
                    console.debug("node event", event);
                    setState({
                        events_version: state.events_version + 1,
                        events_connected: true
                    });
                    const toast = eventToToast(event);
                    if (toast) showToast(toast);
                    actions.sync();
                },
                () => setState({ events_connected: false }),
                () => setState({ events_connected: true })
            );

            syncInterval = setInterval(async () => {
                await actions.sync();
            }, SYNC_INTERVAL_MS);

            await actions.priceCheck();
            priceInterval = setInterval(
                async () => {
                    await actions.priceCheck();
                },
                60 * 1000 * state.price_sync_backoff_multiple
            );
        },
        teardown() {
            if (syncInterval) clearInterval(syncInterval);
            if (priceInterval) clearInterval(priceInterval);
            if (unsubscribeEvents) unsubscribeEvents();
            syncInterval = undefined;
            priceInterval = undefined;
            unsubscribeEvents = undefined;
        },
        async priceCheck(): Promise<void> {
            try {
                const price = await actions.fetchPrice(state.fiat);
                setState({
                    price: price || 0,
                    fiat: state.fiat,
                    price_sync_backoff_multiple: 1
                });
            } catch {
                setState({
                    price: 1,
                    fiat: BTC_OPTION,
                    price_sync_backoff_multiple:
                        state.price_sync_backoff_multiple * 2
                });
            }
        },
        async sync(): Promise<void> {
            try {
                if (!state.is_syncing && state.load_stage === "done") {
                    setState({ is_syncing: true });
                    const newBalance = await sw.get_balance();
                    const toast = onchainChangeToast(state.balance, newBalance);
                    if (toast) showToast(toast);
                    setState({
                        balance: newBalance,
                        last_sync: Date.now()
                    });
                }
            } catch (e) {
                console.error(e);
            } finally {
                setState({ is_syncing: false });
            }
        },
        async fetchPrice(fiat: Currency): Promise<number | undefined> {
            if (fiat.value === "BTC") {
                return 1;
            }
            // mempool.space publishes a small set of fiat prices with no key.
            const res = await fetch("https://mempool.space/api/v1/prices");
            if (!res.ok) throw new Error("Price fetch failed");
            const prices = (await res.json()) as Record<string, number>;
            const price = prices[fiat.value.toUpperCase()];
            if (!price) throw new Error(`No price for ${fiat.value}`);
            return price;
        },
        setScanResult(scan_result: ParsedParams | undefined) {
            setState({ scan_result });
        },
        async saveFiat(fiat: Currency) {
            localStorage.setItem("fiat_currency", JSON.stringify(fiat));
            const price = await actions.fetchPrice(fiat);
            setState({
                price: price,
                fiat: fiat
            });
        },
        saveLanguage(lang: string) {
            localStorage.setItem("i18nextLng", lang);
            setState({ lang });
        },
        setPreferredInvoiceType(type: "unified" | "lightning" | "onchain") {
            setState({ preferredInvoiceType: type });
        },
        async handleIncomingString(
            str: string,
            onError: (e: Error) => void,
            onSuccess: (value: ParsedParams) => void
        ): Promise<void> {
            const network = state.network || "bitcoin";
            const result = await toParsedParams(str || "", network);

            if (!result || !result.ok) {
                if (onError) {
                    onError(result.error);
                }
                return;
            }
            if (
                result.value?.address ||
                result.value?.invoice ||
                result.value?.offer ||
                result.value?.node_pubkey
            ) {
                onSuccess(result.value);
            }
        },
        cycleBalanceView() {
            if (state.balanceView === "sats") {
                localStorage.setItem("balanceView", "fiat");
                setState({ balanceView: "fiat" });
            } else if (state.balanceView === "fiat") {
                localStorage.setItem("balanceView", "hidden");
                setState({ balanceView: "hidden" });
            } else {
                localStorage.setItem("balanceView", "sats");
                setState({ balanceView: "sats" });
            }
        }
    };

    // The sidecar said our session is gone: drop to the login screen.
    window.addEventListener(UNAUTHENTICATED_EVENT, () => {
        if (state.load_stage !== "login") {
            actions.teardown();
            setState({ load_stage: "login", wallet_loading: true });
            navigate("/setup");
        }
    });

    // Keep the unused param around: deep links may add query handling later.
    void searchParams;

    return [state, actions, sw] as const;
};

type MegaStoreContextType = ReturnType<typeof makeMegaStoreContext>;

export const MegaStoreContext = createContext<MegaStoreContextType>();
export const useMegaStore = () => useContext(MegaStoreContext)!;

export const Provider: ParentComponent = (props) => {
    const [state, actions, sw] = makeMegaStoreContext();

    onMount(async () => {
        const shouldSetup = await actions.preSetup();
        if (shouldSetup && !state.setup_error) {
            await actions.setup();
        }
    });

    onCleanup(() => {
        actions.teardown();
    });

    return (
        <MegaStoreContext.Provider value={[state, actions, sw]}>
            {props.children}
        </MegaStoreContext.Provider>
    );
};

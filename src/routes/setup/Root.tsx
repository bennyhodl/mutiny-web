import { useNavigate } from "@solidjs/router";
import { KeyRound } from "lucide-solid";
import { createSignal, onMount, Show } from "solid-js";

import logo from "~/assets/mutiny-pixel-logo.png";
import {
    Button,
    DefaultMain,
    InfoBox,
    NiceP,
    SimpleInput,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import { passkeysSupported } from "~/logic/passkeys";
import { useMegaStore } from "~/state/megaStore";
import { eify } from "~/utils";

/** Sign in to the sidecar. With auth off this screen is skipped. */
export function Setup() {
    const [state, actions] = useMegaStore();
    const i18n = useI18n();
    const navigate = useNavigate();

    const [password, setPassword] = createSignal("");
    const [loading, setLoading] = createSignal(false);
    const [passkeyLoading, setPasskeyLoading] = createSignal(false);
    const [error, setError] = createSignal<string>();

    const showPasskey = () => state.has_passkeys && passkeysSupported();

    onMount(() => {
        if (state.load_stage === "done") {
            navigate("/");
        }
    });

    async function handleLogin(e: Event) {
        e.preventDefault();
        setError(undefined);
        setLoading(true);
        try {
            await actions.login(password());
            navigate("/");
        } catch (err) {
            setError(eify(err).message);
        } finally {
            setLoading(false);
        }
    }

    async function handlePasskey() {
        setError(undefined);
        setPasskeyLoading(true);
        try {
            await actions.loginWithPasskey();
            navigate("/");
        } catch (err) {
            // The user closing the browser's passkey sheet is not an error worth showing.
            if ((err as Error)?.name !== "NotAllowedError") {
                setError(eify(err).message);
            }
        } finally {
            setPasskeyLoading(false);
        }
    }

    return (
        <DefaultMain>
            <div class="flex flex-1 flex-col items-center justify-between gap-4">
                <div class="flex-1" />
                <form
                    onSubmit={handleLogin}
                    class="flex w-full max-w-[20rem] flex-col items-center gap-4"
                >
                    <img
                        id="mutiny-logo"
                        src={logo}
                        class="h-[50px] w-[172px]"
                        alt="Mutiny logo"
                    />
                    <NiceP>{i18n.t("setup.initial.welcome")}</NiceP>
                    <div class="h-4" />
                    <VStack>
                        <Show when={showPasskey()}>
                            <Button
                                layout="full"
                                intent="blue"
                                type="button"
                                loading={passkeyLoading()}
                                onClick={handlePasskey}
                            >
                                <div class="flex items-center justify-center gap-2">
                                    <KeyRound class="h-5 w-5" />
                                    {i18n.t("setup.login.passkey")}
                                </div>
                            </Button>
                            <p class="text-center text-sm text-m-grey-400">
                                {i18n.t("setup.login.or_password")}
                            </p>
                        </Show>
                        <SimpleInput
                            type="password"
                            value={password()}
                            placeholder={i18n.t("setup.login.password")}
                            onInput={(e) => setPassword(e.currentTarget.value)}
                        />
                        <Show when={error()}>
                            <InfoBox accent="red">{error()}</InfoBox>
                        </Show>
                        <Button
                            layout="full"
                            type="submit"
                            loading={loading()}
                            disabled={!password()}
                        >
                            {i18n.t("setup.login.sign_in")}
                        </Button>
                    </VStack>
                </form>
                <div class="flex-1" />
            </div>
        </DefaultMain>
    );
}

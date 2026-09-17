import { KeyRound, Trash2 } from "lucide-solid";
import { createResource, createSignal, For, Show, Suspense } from "solid-js";

import {
    BackLink,
    Button,
    ConfirmDialog,
    DefaultMain,
    InfoBox,
    LargeHeader,
    MutinyWalletGuard,
    NavBar,
    NiceP,
    SettingsCard,
    showToast,
    SimpleInput,
    TinyText,
    VStack
} from "~/components";
import { useI18n } from "~/i18n/context";
import {
    deletePasskey,
    listPasskeys,
    PasskeyInfo,
    passkeysSupported,
    registerPasskey
} from "~/logic/passkeys";
import { useMegaStore } from "~/state/megaStore";
import { eify, prettyPrintTime } from "~/utils";

function defaultPasskeyName(): string {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android";
    if (/Mac/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
    return "Passkey";
}

function PasskeyRow(props: { passkey: PasskeyInfo; refetch: () => void }) {
    const i18n = useI18n();
    const [confirmOpen, setConfirmOpen] = createSignal(false);
    const [deleting, setDeleting] = createSignal(false);

    async function remove() {
        setDeleting(true);
        try {
            await deletePasskey(props.passkey.id);
            props.refetch();
        } catch (e) {
            showToast(eify(e));
        } finally {
            setDeleting(false);
            setConfirmOpen(false);
        }
    }

    return (
        <div class="flex items-center gap-3 px-4 py-2">
            <KeyRound class="h-5 w-5 text-m-grey-350" />
            <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate">{props.passkey.name}</span>
                <span class="text-sm text-m-grey-400">
                    {prettyPrintTime(props.passkey.created_at)}
                </span>
            </div>
            <button
                class="rounded-lg p-2 text-m-red hover:bg-white/5"
                onClick={() => setConfirmOpen(true)}
                aria-label={i18n.t("settings.security.remove")}
            >
                <Trash2 class="h-5 w-5" />
            </button>
            <ConfirmDialog
                loading={deleting()}
                open={confirmOpen()}
                onConfirm={remove}
                onCancel={() => setConfirmOpen(false)}
            >
                {i18n.t("settings.security.remove_confirm", {
                    name: props.passkey.name
                })}
            </ConfirmDialog>
        </div>
    );
}

/** Passkeys for signing in to this wallet. */
export function Security() {
    const i18n = useI18n();
    const [state, actions] = useMegaStore();

    const [name, setName] = createSignal(defaultPasskeyName());
    const [adding, setAdding] = createSignal(false);
    const [error, setError] = createSignal<string>();

    const [passkeys, { refetch }] = createResource(async () => {
        try {
            const list = await listPasskeys();
            actions.setHasPasskeys(list.length > 0);
            return list;
        } catch (e) {
            console.error(e);
            return [] as PasskeyInfo[];
        }
    });

    async function add(e: Event) {
        e.preventDefault();
        setError(undefined);
        setAdding(true);
        try {
            await registerPasskey(name().trim());
            showToast({
                title: i18n.t("settings.security.added_title"),
                description: i18n.t("settings.security.added_body")
            });
            refetch();
        } catch (err) {
            if ((err as Error)?.name !== "NotAllowedError") {
                setError(eify(err).message);
            }
        } finally {
            setAdding(false);
        }
    }

    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <BackLink href="/settings" title={i18n.t("settings.header")} />
                <LargeHeader>{i18n.t("settings.security.title")}</LargeHeader>
                <VStack>
                    <NiceP>{i18n.t("settings.security.description")}</NiceP>
                    <Show when={!state.auth_enabled}>
                        <InfoBox accent="blue">
                            {i18n.t("settings.security.auth_off")}
                        </InfoBox>
                    </Show>
                    <Show when={state.auth_enabled && !passkeysSupported()}>
                        <InfoBox accent="red">
                            {i18n.t("settings.security.unsupported")}
                        </InfoBox>
                    </Show>
                    <Show when={state.auth_enabled && passkeysSupported()}>
                        <SettingsCard
                            title={i18n.t("settings.security.passkeys")}
                        >
                            <Suspense>
                                <For
                                    each={passkeys.latest}
                                    fallback={
                                        <div class="px-4 py-2">
                                            <TinyText>
                                                {i18n.t(
                                                    "settings.security.none"
                                                )}
                                            </TinyText>
                                        </div>
                                    }
                                >
                                    {(passkey) => (
                                        <PasskeyRow
                                            passkey={passkey}
                                            refetch={refetch}
                                        />
                                    )}
                                </For>
                            </Suspense>
                            <form
                                class="flex flex-col gap-4 p-4"
                                onSubmit={add}
                            >
                                <SimpleInput
                                    type="text"
                                    value={name()}
                                    placeholder={i18n.t(
                                        "settings.security.name_placeholder"
                                    )}
                                    onInput={(e) =>
                                        setName(e.currentTarget.value)
                                    }
                                />
                                <Button
                                    layout="small"
                                    intent="blue"
                                    type="submit"
                                    loading={adding()}
                                >
                                    {i18n.t("settings.security.add")}
                                </Button>
                                <Show when={error()}>
                                    <InfoBox accent="red">{error()}</InfoBox>
                                </Show>
                            </form>
                        </SettingsCard>
                    </Show>
                </VStack>
            </DefaultMain>
            <NavBar activeTab="settings" />
        </MutinyWalletGuard>
    );
}

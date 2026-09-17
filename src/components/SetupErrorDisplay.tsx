import { Title } from "@solidjs/meta";

import { Button, DefaultMain, LargeHeader, NiceP } from "~/components";
import { useI18n } from "~/i18n/context";

/** Shown when the wallet cannot reach or read the sidecar at start. */
export function SetupErrorDisplay(props: { initialError: Error }) {
    // Error shouldn't be reactive, so we assign to it so it just gets rendered with the first value
    const i18n = useI18n();
    const error = props.initialError;

    return (
        <DefaultMain>
            <Title>{i18n.t("error.on_boot.loading_failed.title")}</Title>
            <LargeHeader>
                {i18n.t("error.on_boot.loading_failed.header")}
            </LargeHeader>
            <p class="rounded-xl bg-white/10 p-4 font-mono">
                <span class="font-bold">{error.name}</span>: {error.message}
            </p>
            <NiceP>{i18n.t("error.on_boot.loading_failed.description")}</NiceP>
            <Button onClick={() => window.location.reload()}>
                {i18n.t("error.reload")}
            </Button>
        </DefaultMain>
    );
}

import { createResource, Match, Switch } from "solid-js";

import { InfoBox } from "~/components/InfoBox";
import { useI18n } from "~/i18n/context";
import { ReceiveFlavor } from "~/routes";
import { useMegaStore } from "~/state/megaStore";

export function ReceiveWarnings(props: {
    amountSats: bigint;
    flavor?: ReceiveFlavor;
}) {
    const i18n = useI18n();
    const [_state, _actions, sw] = useMegaStore();

    const [inboundCapacity] = createResource(async () => {
        try {
            const channels = await sw.list_channels();
            let inbound = 0n;
            for (const channel of channels) {
                if (channel.is_usable) inbound += channel.inbound;
            }
            return inbound;
        } catch (e) {
            console.error(e);
            return 0n;
        }
    });

    const warningText = () => {
        if (props.flavor === "lightning") {
            if (inboundCapacity.latest === 0n) {
                return i18n.t("receive.no_inbound");
            }
            if (props.amountSats > (inboundCapacity.latest || 0n)) {
                return i18n.t("receive.amount_over_inbound", {
                    amount: (inboundCapacity.latest || 0n).toLocaleString()
                });
            }
        }
        return undefined;
    };

    const sillyAmountWarning = () => {
        const parsed = Number(props.amountSats);
        if (isNaN(parsed)) {
            return undefined;
        }

        if (parsed >= 2099999997690000) {
            // If over 21 million bitcoin, warn that too much
            return i18n.t("receive.amount_editable.more_than_21m");
        }
    };

    const tooSmallWarning = () => {
        if (
            props.flavor === "onchain" &&
            props.amountSats > 0n &&
            props.amountSats < 546n
        ) {
            return i18n.t("receive.error_under_min_onchain");
        }
    };

    return (
        <Switch>
            <Match when={tooSmallWarning()}>
                <InfoBox accent="red">{tooSmallWarning()}</InfoBox>
            </Match>
            <Match when={sillyAmountWarning()}>
                <InfoBox accent="red">{sillyAmountWarning()}</InfoBox>
            </Match>
            <Match when={warningText()}>
                <InfoBox accent="blue">{warningText()}</InfoBox>
            </Match>
        </Switch>
    );
}

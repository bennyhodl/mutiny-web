import { createResource, createSignal, JSX, Match, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";

import avatar from "~/assets/generic-avatar.jpg";
import { generateGradient } from "~/utils";

export function Circle(props: {
    children: JSX.Element;
    color?: "red" | "green" | "blue";
    size?: "small" | "large" | "xl";
    background?: string;
    onClick?: () => void;
}) {
    return (
        <Dynamic
            component={props.onClick ? "button" : "div"}
            onClick={props.onClick}
            class="flex flex-none items-center justify-center overflow-clip rounded-full border-t border-b border-t-white/50 border-b-white/10 text-3xl uppercase"
            classList={{
                "bg-m-grey-800": !props.color && !props.background,
                "bg-m-red": props.color === "red" && !props.background,
                "bg-m-green": props.color === "green" && !props.background,
                "h-12 w-12": !props.size,
                "h-16 w-16": props.size === "large",
                "h-32 w-32": props.size === "xl",
                "active:mt-px active:-mb-px": !!props.onClick
            }}
            style={{
                background: props.background
            }}
        >
            {props.children}
        </Dynamic>
    );
}

export function LabelCircle(props: {
    name?: string;
    image_url?: string;
    contact: boolean;
    label: boolean;
    generic?: boolean;
    size?: "small" | "large" | "xl";
    onClick?: () => void;
}) {
    const [gradient] = createResource(async () => {
        if (props.name && props.name !== "Anonymous" && props.contact) {
            return generateGradient(props.name || "?");
        } else {
            return undefined;
        }
    });

    const text = () =>
        props.contact &&
        props.name &&
        props.name.length &&
        props.name !== "Anonymous"
            ? props.name[0]
            : props.label
              ? "≡"
              : "?";
    const bg = () => (props.name && props.contact ? gradient() : "");

    const [errored, setErrored] = createSignal(false);

    return (
        <Circle
            background={props.image_url && !errored() ? "none" : bg()}
            onClick={
                props.onClick
                    ? () => props.onClick && props.onClick()
                    : undefined
            }
            size={props.size}
        >
            <Switch>
                <Match when={errored()}>{text()}</Match>
                <Match when={props.image_url}>
                    <img
                        src={props.image_url}
                        alt={"image"}
                        onError={(e) => {
                            // This doesn't stop the console errors from showing up
                            e.stopPropagation();
                            setErrored(true);
                        }}
                    />
                </Match>
                <Match when={text() === "?" || props.generic}>
                    <img src={avatar} alt="avatar" />
                </Match>
                <Match when={true}>{text()}</Match>
            </Switch>
        </Circle>
    );
}

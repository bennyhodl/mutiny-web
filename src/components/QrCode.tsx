import QRCode from "qrcode";
import { createResource } from "solid-js";

/** An SVG QR code that scales to its container. */
export function QrCode(props: { value: string; class?: string }) {
    const [svg] = createResource(
        () => props.value,
        (value) =>
            QRCode.toString(value, {
                type: "svg",
                margin: 1,
                errorCorrectionLevel: "L"
            })
    );

    // The markup comes from the qrcode library, not from user input.
    // eslint-disable-next-line solid/no-innerhtml
    return (
        <div class={props.class} innerHTML={svg() ?? ""} aria-label="QR code" />
    );
}

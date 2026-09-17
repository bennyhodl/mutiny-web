// Passkeys (WebAuthn) against the sidecar. The sidecar speaks the standard
// WebAuthn JSON transport (base64url strings for the binary fields); these
// helpers convert to and from the ArrayBuffers the browser API wants.

import { RpcError } from "./ldkApi";

export type PasskeyInfo = { id: string; name: string; created_at: number };

export function passkeysSupported(): boolean {
    return (
        typeof window !== "undefined" &&
        !!window.PublicKeyCredential &&
        !!navigator.credentials
    );
}

function b64urlToBuf(s: string): ArrayBuffer {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function bufToB64url(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function post<T>(path: string, body: object = {}): Promise<T> {
    const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        let code = "Error";
        let message = res.statusText;
        try {
            const j = await res.json();
            code = j.code ?? code;
            message = j.message ?? message;
        } catch {
            /* non-JSON error */
        }
        throw new RpcError(code, message, res.status);
    }
    return res.json();
}

type Descriptor = { id: string; type: string; transports?: string[] };

function toDescriptors(
    list?: Descriptor[]
): PublicKeyCredentialDescriptor[] | undefined {
    return list?.map((d) => ({
        id: b64urlToBuf(d.id),
        type: d.type as PublicKeyCredentialType,
        transports: d.transports as AuthenticatorTransport[] | undefined
    }));
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
    const res = await fetch("/api/auth/passkeys");
    if (!res.ok) throw new RpcError("Error", res.statusText, res.status);
    return res.json();
}

export async function deletePasskey(id: string): Promise<void> {
    await post("/api/auth/passkey/delete", { id });
}

/** Enrol a new passkey on this device. Needs a signed-in session. */
export async function registerPasskey(name: string): Promise<PasskeyInfo> {
    const start = await post<{
        challenge_id: string;
        options: { publicKey: Record<string, unknown> };
    }>("/api/auth/passkey/register/start");

    const pk = start.options.publicKey;
    const user = pk.user as { id: string; name: string; displayName: string };
    const publicKey: PublicKeyCredentialCreationOptions = {
        ...(pk as unknown as PublicKeyCredentialCreationOptions),
        challenge: b64urlToBuf(pk.challenge as string),
        user: { ...user, id: b64urlToBuf(user.id) },
        excludeCredentials: toDescriptors(pk.excludeCredentials as Descriptor[])
    };

    const cred = (await navigator.credentials.create({
        publicKey
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("No credential was created");
    const response = cred.response as AuthenticatorAttestationResponse;

    return post<PasskeyInfo>("/api/auth/passkey/register/finish", {
        challenge_id: start.challenge_id,
        name,
        credential: {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            response: {
                attestationObject: bufToB64url(response.attestationObject),
                clientDataJSON: bufToB64url(response.clientDataJSON),
                transports: response.getTransports?.() ?? undefined
            },
            extensions: cred.getClientExtensionResults()
        }
    });
}

/** Sign in with any passkey registered for this wallet. Sets the session cookie. */
export async function loginWithPasskey(): Promise<void> {
    const start = await post<{
        challenge_id: string;
        options: { publicKey: Record<string, unknown> };
    }>("/api/auth/passkey/login/start");

    const pk = start.options.publicKey;
    const publicKey: PublicKeyCredentialRequestOptions = {
        ...(pk as unknown as PublicKeyCredentialRequestOptions),
        challenge: b64urlToBuf(pk.challenge as string),
        allowCredentials: toDescriptors(pk.allowCredentials as Descriptor[])
    };

    const cred = (await navigator.credentials.get({
        publicKey
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("No credential was returned");
    const response = cred.response as AuthenticatorAssertionResponse;

    await post("/api/auth/passkey/login/finish", {
        challenge_id: start.challenge_id,
        credential: {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            response: {
                authenticatorData: bufToB64url(response.authenticatorData),
                clientDataJSON: bufToB64url(response.clientDataJSON),
                signature: bufToB64url(response.signature),
                userHandle: response.userHandle
                    ? bufToB64url(response.userHandle)
                    : null
            },
            extensions: cred.getClientExtensionResults()
        }
    });
}

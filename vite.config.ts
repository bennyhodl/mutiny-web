import child from "node:child_process";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA, VitePWAOptions } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";

import manifest from "./manifest";

const commitHash =
    process.env.VITE_COMMIT_HASH ??
    child.execSync("git rev-parse --short HEAD").toString().trim();

// Where the mutiny-sidecar listens during development. In production the
// sidecar serves the built app itself, so everything is same-origin.
const sidecar = process.env.SIDECAR_URL ?? "http://127.0.0.1:8890";

const pwaOptions: Partial<VitePWAOptions> = {
    base: "/",
    registerType: "prompt",
    devOptions: {
        enabled: false
    },
    workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,gif}"]
    },
    includeAssets: ["favicon.ico", "robots.txt"],
    manifest: manifest
};

export default defineConfig({
    build: {
        target: "esnext",
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: true
    },
    server: {
        port: 3420,
        proxy: {
            "/api": {
                target: sidecar,
                changeOrigin: false
            }
        }
    },
    plugins: [tailwindcss(), solid(), VitePWA(pwaOptions)],
    define: {
        "import.meta.env.__COMMIT_HASH__": JSON.stringify(commitHash),
        "import.meta.env.__RELEASE_VERSION__": JSON.stringify(
            process.env.npm_package_version
        )
    },
    resolve: {
        alias: [{ find: "~", replacement: path.resolve(__dirname, "./src") }]
    },
    optimizeDeps: {
        // Don't want vite to bundle these late during dev causing reload
        include: [
            "qr-scanner",
            "i18next",
            "i18next-browser-languagedetector",
            "@capacitor-mlkit/barcode-scanning",
            "@capacitor/app",
            "@capacitor/app-launcher",
            "@capacitor/clipboard",
            "@capacitor/core",
            "@capacitor/filesystem",
            "@capacitor/haptics",
            "@capacitor/share",
            "@capacitor/status-bar",
            "@capacitor/toast"
        ],
        esbuildOptions: {
            target: "esnext"
        }
    }
});

import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import solid from "eslint-plugin-solid/configs/typescript";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "server/**",
            "android/**",
            "ios/**"
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    importPlugin.flatConfigs.recommended,
    importPlugin.flatConfigs.typescript,
    {
        files: ["src/**/*.{ts,tsx}"],
        ...solid,
        languageOptions: {
            ...solid.languageOptions,
            globals: { ...globals.browser, ...globals.node },
            parserOptions: {
                project: "tsconfig.json",
                tsconfigRootDir: import.meta.dirname
            }
        },
        settings: {
            "import/parsers": {
                "@typescript-eslint/parser": [".ts", ".tsx"]
            },
            "import/resolver": {
                typescript: {
                    project: ["./tsconfig.json"],
                    alwaysTryTypes: true
                }
            }
        },
        rules: {
            ...solid.rules,
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    varsIgnorePattern: "^_"
                }
            ],
            "solid/reactivity": "warn",
            "solid/no-destructure": "warn",
            "solid/jsx-no-undef": "error",
            "@typescript-eslint/no-non-null-assertion": "off"
        }
    }
);

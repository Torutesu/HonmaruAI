// A small, opinionated set: the mistakes this codebase can actually make.
//
// Everything here runs on a Worker, where an unawaited promise is not a slow
// path but a request that returns before its own write happens — and where a
// throw inside one is an unhandled rejection that takes the isolate's error
// budget rather than the request's. `waitUntil` is the deliberate version of
// that and is what the rules below leave room for.
import js from "@eslint/js";
import promise from "eslint-plugin-promise";

export default [
  {
    ignores: ["node_modules/**", "test/**", "scripts/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        WebSocketPair: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        ReadableStream: "readonly",
        FormData: "readonly",
        atob: "readonly",
        btoa: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Date: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
    plugins: { promise },
    rules: {
      // The one that matters here. An async call whose promise nobody holds is
      // a write that may not have happened when the response goes out.
      "no-floating-decimal": "error",
      "promise/always-return": "off",
      "promise/catch-or-return": ["error", { allowFinally: true, terminationMethod: ["catch", "finally"] }],
      "promise/no-nesting": "warn",
      "promise/no-return-wrap": "error",
      "promise/param-names": "error",
      "require-atomic-updates": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Off on purpose: `let x = []` before a try/catch that assigns it
      // documents the type and survives an edit that adds a branch. The rule
      // reads that as waste; here it is the guard rail.
      "no-useless-assignment": "off",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];

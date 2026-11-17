import path from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vitest/config";

import manifest from "./src/manifest.json" with { type: "json" };
import pkg from "./package.json" with { type: "json" };

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  // `package.json` is the single source of truth for the version: it's
  // stamped into the built manifest and exposed to the UI as
  // `__APP_VERSION__`. `scripts/sync-version.mjs` keeps the copy in
  // `src/manifest.json` in step for anyone reading the source.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest: { ...manifest, version: pkg.version } }),
  ],
  build: {
    outDir: "dist/chrome",
    // `prompt.html`, `highlight.html` and `archive.html` aren't
    // referenced from the manifest (they're opened on demand by
    // chrome.windows.create from the background), so declare them as
    // additional inputs so Vite still builds them. The wallet view
    // shares the options bundle and is reached via
    // `options.html#/wallet` (HashRouter), so it doesn't need its own
    // entry.
    rollupOptions: {
      input: {
        prompt: path.resolve(__dirname, "src/prompt.html"),
        highlight: path.resolve(__dirname, "src/highlight.html"),
        archive: path.resolve(__dirname, "src/archive.html"),
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/{vite,eslint}.config.*",
      ".agents/**",
    ],
    onConsoleLog(log) {
      return !log.includes("React Router Future Flag Warning");
    },
    env: {
      DEBUG_PRINT_LIMIT: "0",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));

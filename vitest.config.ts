import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "node_modules",
      "dist",
      // Exclude sub-package node_modules (e.g. packages/fleet-signer/node_modules)
      "packages/*/node_modules/**",
    ],
  },
});

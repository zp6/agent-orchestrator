import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default Vitest timeout is 5 s. Several tests invoke the real `gh` CLI
    // against dummy repos and can take 6-8 s locally when the GitHub API
    // rate-limits or takes time to return a 404.  CI passes because it runs
    // on faster hardware; bump the local timeout to 30 s so those tests don't
    // spuriously fail during pre-push checks.
    // TODO(#1523): replace real `gh` calls in trigger-dispatcher tests with mocks.
    testTimeout: 30000,
    exclude: [
      "node_modules",
      "dist",
      // Exclude sub-package node_modules (e.g. packages/fleet-signer/node_modules)
      "packages/*/node_modules/**",
      // Exclude agent worktrees checked out under .claude/
      ".claude/worktrees/**",
    ],
  },
});

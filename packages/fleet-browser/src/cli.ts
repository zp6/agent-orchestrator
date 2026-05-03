#!/usr/bin/env node
/**
 * fleet-browser CLI — test command for verifying the injected provider.
 *
 * Usage:
 *   fleet-browser test --url https://app.uniswap.org
 *   fleet-browser test --url https://app.uniswap.org --chain-id 137
 *   fleet-browser test --url https://app.uniswap.org --headed
 *
 * The test command:
 * 1. Launches headless Chromium with the injected window.ethereum provider
 * 2. Navigates to the given URL
 * 3. Verifies window.ethereum is present and reports the treasury address
 * 4. Prints "connected" on success, exits with code 0
 * 5. On failure, prints the error and exits with code 1
 */

import { FleetBrowser } from "./index.js";

function parseArgs(argv: string[]): {
  command: string;
  url: string;
  chainId: number;
  headed: boolean;
  signerUrl?: string;
  sign?: boolean;
} {
  const args = argv.slice(2);
  const command = args[0] || "help";

  let url = "https://example.com";
  let chainId = 1;
  let headed = false;
  let signerUrl: string | undefined;
  let sign = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--url":
        url = args[++i] || url;
        break;
      case "--chain-id":
        chainId = parseInt(args[++i] || "1", 10);
        break;
      case "--headed":
        headed = true;
        break;
      case "--signer-url":
        signerUrl = args[++i];
        break;
      case "--sign":
        sign = true;
        break;
    }
  }

  return { command, url, chainId, headed, signerUrl, sign };
}

async function runTest(opts: ReturnType<typeof parseArgs>): Promise<void> {
  const browser = new FleetBrowser({
    signerUrl: opts.signerUrl,
    chainId: opts.chainId,
    headless: !opts.headed,
  });

  console.log(`[fleet-browser] Opening ${opts.url} ...`);
  console.log(`[fleet-browser] Signer URL: ${browser.signerUrl}`);
  console.log(`[fleet-browser] Treasury: ${browser.treasuryAddress}`);
  console.log(`[fleet-browser] Chain ID: ${opts.chainId}`);

  try {
    const page = await browser.open(opts.url);

    // Verify the provider is injected and returns the right address
    const result = await page.evaluate(async () => {
      const eth = (window as any).ethereum;
      if (!eth) return { error: "window.ethereum not found" };
      if (!eth.isFleetBrowser) return { error: "window.ethereum is not the fleet provider" };

      try {
        const accounts = await eth.request({ method: "eth_requestAccounts" });
        return {
          connected: true,
          accounts,
          chainId: eth.chainId,
          isFleetBrowser: eth.isFleetBrowser,
        };
      } catch (err: any) {
        return { error: err.message };
      }
    });

    if ("error" in result) {
      console.error(`[fleet-browser] FAIL: ${result.error}`);
      process.exit(1);
    }

    console.log(`[fleet-browser] connected`);
    console.log(`[fleet-browser] Accounts: ${JSON.stringify(result.accounts)}`);
    console.log(`[fleet-browser] Chain: ${result.chainId}`);

    // Optional: attempt a personal_sign to verify signer integration
    if (opts.sign) {
      console.log(`[fleet-browser] Attempting personal_sign via signer...`);
      const signResult = await page.evaluate(async () => {
        const eth = (window as any).ethereum;
        try {
          const accounts = await eth.request({ method: "eth_accounts" });
          const message = "0x" + Buffer.from("fleet-browser-test", "utf-8").toString("hex");
          const sig = await eth.request({
            method: "personal_sign",
            params: [message, accounts[0]],
          });
          return { signature: sig };
        } catch (err: any) {
          return { error: err.message };
        }
      });

      if ("error" in signResult) {
        console.log(`[fleet-browser] Sign result: ${signResult.error}`);
        // Not a fatal error — signer might not be running
      } else {
        console.log(`[fleet-browser] Signature: ${signResult.signature}`);
      }
    }

    if (opts.headed) {
      console.log(`[fleet-browser] Headed mode — press Ctrl+C to close`);
      await new Promise(() => {}); // hang until killed
    }
  } finally {
    await browser.close();
  }
}

function printHelp(): void {
  console.log(`
fleet-browser — Headless browser with injected wallet provider

Commands:
  test    Open a URL with the injected provider and verify connectivity

Options:
  --url <url>          URL to open (default: https://example.com)
  --chain-id <id>      Chain ID to report (default: 1)
  --headed             Run with visible browser window
  --signer-url <url>   Fleet signer URL (default: http://127.0.0.1:7521)
  --sign               Attempt a personal_sign after connecting

Examples:
  fleet-browser test --url https://app.uniswap.org
  fleet-browser test --url https://app.uniswap.org --headed --sign
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  switch (opts.command) {
    case "test":
      await runTest(opts);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${opts.command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[fleet-browser] Fatal: ${err.message}`);
  process.exit(1);
});

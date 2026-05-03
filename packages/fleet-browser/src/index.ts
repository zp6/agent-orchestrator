/**
 * FleetBrowser — headless Chromium with an injected window.ethereum provider
 * that routes all signing requests to the fleet-signer service.
 *
 * Usage:
 *   const browser = new FleetBrowser({ signerUrl: 'http://127.0.0.1:7521' });
 *   const page = await browser.open('https://app.uniswap.org');
 *   // page.ethereum is connected with the treasury address
 *   await browser.close();
 *
 * The browser NEVER holds a private key. All eth_sendTransaction, personal_sign,
 * and eth_signTypedData_v4 calls are forwarded to the fleet-signer HTTP service
 * which enforces its whitelist, per-tx caps, and daily caps.
 *
 * Issue #1429.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildProviderScript, type ProviderConfig } from "./provider-script.js";

/** Default treasury address — the fleet's on-chain identity. */
const DEFAULT_TREASURY_ADDRESS = "0x468EC325C5E5059032aB62b613FE132e0a97EA05";

export interface FleetBrowserConfig {
  /** Fleet signer HTTP URL. Default: http://127.0.0.1:7521 */
  signerUrl?: string;
  /** Treasury address to expose as the connected wallet. */
  treasuryAddress?: string;
  /** Chain ID to report to dApps. Default: 1 (mainnet). */
  chainId?: number;
  /** Run in headed mode (visible browser window). Default: false. */
  headless?: boolean;
  /** Additional Chromium launch args. */
  launchArgs?: string[];
}

export class FleetBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly config: Required<
    Pick<FleetBrowserConfig, "signerUrl" | "treasuryAddress" | "chainId" | "headless">
  > & { launchArgs: string[] };

  constructor(config: FleetBrowserConfig = {}) {
    this.config = {
      signerUrl:
        config.signerUrl ??
        process.env.SIGNER_URL ??
        (process.env.FLEET_BROWSER_DOCKER === "1"
          ? "http://host.docker.internal:7521"
          : "http://127.0.0.1:7521"),
      treasuryAddress: config.treasuryAddress ?? DEFAULT_TREASURY_ADDRESS,
      chainId: config.chainId ?? 1,
      headless: config.headless ?? true,
      launchArgs: config.launchArgs ?? [],
    };
  }

  /**
   * Launch Chromium, inject the provider, and navigate to the given URL.
   * Returns the Playwright Page object for further interaction.
   */
  async open(url: string): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: [
          "--disable-blink-features=AutomationControlled",
          ...this.config.launchArgs,
        ],
      });
    }

    const providerConfig: ProviderConfig = {
      treasuryAddress: this.config.treasuryAddress,
      signerUrl: this.config.signerUrl,
      chainId: this.config.chainId,
    };

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });

    // Inject the provider before any page JS runs
    await this.context.addInitScript({
      content: buildProviderScript(providerConfig),
    });

    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    return page;
  }

  /** Close browser and all contexts. */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /** Get the treasury address this browser exposes. */
  get treasuryAddress(): string {
    return this.config.treasuryAddress;
  }

  /** Get the signer URL being used. */
  get signerUrl(): string {
    return this.config.signerUrl;
  }
}

export { buildProviderScript, type ProviderConfig } from "./provider-script.js";
export {
  executeCowSwap,
  buildCowSwapUrl,
  formatTokenAmount,
  parseTokenAmount,
  COWSWAP_CHAINS,
  BASE_TOKENS,
  type CowSwapChain,
  type CowSwapOrderParams,
  type CowSwapOrderResult,
} from "./recipes/cowswap.js";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const walletAddress = process.env.FLEET_WALLET_ADDRESS?.trim();

if (!walletAddress) {
  throw new Error("FLEET_WALLET_ADDRESS is required to render revenue assets.");
}

const { renderRevenueLandingPage, getSurvivalStatusPayload } = await import("../dist/index.js");

const payload = getSurvivalStatusPayload({
  getSystemFlag: () => null,
  setSystemFlag: () => undefined,
});

// Override the payload wallet with the canonical runtime value used by the generator.
payload.walletAddress = walletAddress;

const html = renderRevenueLandingPage({
  ...payload,
  walletAddress,
});

const outputPath = resolve(fileURLToPath(new URL("../docs/revenue-landing.html", import.meta.url)));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, html, "utf8");

console.log(`Wrote ${outputPath}`);

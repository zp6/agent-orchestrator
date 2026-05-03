#!/usr/bin/env node
/**
 * fleet-signer CLI — `setup` and `start` commands.
 *
 *   fleet-signer setup           # Prompt for passphrase + seed/key, store encrypted on disk
 *   fleet-signer start           # Prompt for passphrase, decrypt key into memory, run HTTP server
 *
 * Phase 1 lives at ~/.fleet-signer/key.enc and audits to ~/.fleet-signer/audit.log
 * by default. Localhost-only HTTP listener on :7521.
 */

import * as readline from "node:readline";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { encryptAndStore, loadAndDecrypt, envelopeExists } from "./storage/encrypted-key.js";
import { startSignerServer } from "./server.js";
import { AuditLog } from "./audit.js";

const keyPath = process.env.FLEET_SIGNER_KEY_PATH;
const auditPath = process.env.FLEET_SIGNER_AUDIT_PATH;

/** Read a single line of input from stdin without echoing (passphrase / seed). */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY: boolean };
    if (stdin.isTTY) stdin.setRawMode(true);

    let buf = "";
    const onData = (data: Buffer) => {
      const ch = data.toString("utf8");
      if (ch === "\r" || ch === "\n") {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(buf);
        return;
      }
      if (ch === "") {
        // Ctrl-C
        process.exit(130);
      }
      if (ch === "" || ch === "") {
        buf = buf.slice(0, -1);
        return;
      }
      buf += ch;
    };
    stdin.on("data", onData);
  });
}

function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); }));
}

/**
 * Convert a 12-or-24-word mnemonic OR a 0x-prefixed private key into
 * a 64-char hex private key suitable for encryptAndStore.
 */
function normalizeKeyInput(input: string): string {
  const trimmed = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  }
  // Treat as mnemonic. Validate by deriving an account; if it works, return the key.
  try {
    const account = mnemonicToAccount(trimmed);
    // viem's mnemonicToAccount returns a HDAccount — we need to expose the privateKey.
    // The newer viem API: mnemonicToAccount returns an account with .source containing
    // the mnemonic, but the privateKey is buried. Use a fresh derivation:
    const hdNodeKey = (account as unknown as { getHdKey: () => { privateKey: Uint8Array } }).getHdKey();
    const hex = Buffer.from(hdNodeKey.privateKey).toString("hex");
    return hex;
  } catch {
    throw new Error("Input is neither a 64-char hex private key nor a valid mnemonic");
  }
}

async function cmdSetup(): Promise<void> {
  if (await envelopeExists(keyPath)) {
    const overwrite = await readLine("An encrypted key already exists at ~/.fleet-signer/key.enc. Overwrite? (yes/no): ");
    if (overwrite.toLowerCase() !== "yes") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  console.log("Enter the wallet's seed phrase (12 or 24 words) or a 0x-prefixed private key.");
  console.log("Input is hidden. The plaintext key is never written to disk.\n");
  const keyInput = await readSecret("Seed or key: ");

  let normalizedKey: string;
  try {
    normalizedKey = normalizeKeyInput(keyInput);
  } catch (err) {
    console.error(`Setup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const account = privateKeyToAccount(`0x${normalizedKey}`);
  console.log(`Derived address: ${account.address}`);
  console.log("If this matches the fleet treasury wallet you intended, continue.\n");

  const passphrase = await readSecret("Set a passphrase (used to decrypt at start time): ");
  const confirm = await readSecret("Confirm passphrase: ");
  if (passphrase !== confirm) {
    console.error("Passphrases do not match. Aborted.");
    process.exit(1);
  }
  if (passphrase.length < 12) {
    console.error("Passphrase must be at least 12 characters. Aborted.");
    process.exit(1);
  }

  await encryptAndStore(`0x${normalizedKey}`, passphrase, keyPath);
  console.log("Encrypted key stored at ~/.fleet-signer/key.enc (mode 0600)");
  console.log("Run `fleet-signer start` to launch the HTTP signer.");
}

async function cmdStart(): Promise<void> {
  if (!(await envelopeExists(keyPath))) {
    console.error("No encrypted key found at ~/.fleet-signer/key.enc — run `fleet-signer setup` first.");
    process.exit(1);
  }

  const passphraseEnv = process.env.FLEET_SIGNER_PASSPHRASE;
  const passphrase = passphraseEnv ?? (await readSecret("Passphrase: "));

  let privateKey: `0x${string}`;
  try {
    privateKey = await loadAndDecrypt(passphrase, keyPath);
  } catch (err) {
    console.error(`Decrypt failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const port = parseInt(process.env.FLEET_SIGNER_PORT ?? "7521", 10);
  const bindHost = process.env.FLEET_SIGNER_BIND_HOST ?? "127.0.0.1";
  const server = startSignerServer({ privateKey, port, bindHost, auditLog: new AuditLog(auditPath) });

  const account = privateKeyToAccount(privateKey);
  console.log(`Fleet signer listening on http://${bindHost}:${port}`);
  console.log(`Address: ${account.address}`);
  console.log("Whitelist: Phase 1 — Aave V3 supply USDC + ERC20 approve USDC, max $50/tx, $100/day");
  console.log("Audit log: ~/.fleet-signer/audit.log");

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "setup":
      await cmdSetup();
      return;
    case "start":
      await cmdStart();
      return;
    default:
      console.error(`Usage: fleet-signer (setup|start)\n\n  setup   Encrypt a seed/key with a passphrase, store on disk\n  start   Launch the localhost HTTP signer`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

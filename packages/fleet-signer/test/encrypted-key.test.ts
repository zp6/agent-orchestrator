import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encryptAndStore, loadAndDecrypt, envelopeExists } from "../src/storage/encrypted-key.js";

const VALID_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSPHRASE = "correct horse battery staple";

let tmpEnvelope: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-signer-test-"));
  tmpEnvelope = path.join(dir, "key.enc");
});

afterEach(async () => {
  try {
    await fs.rm(path.dirname(tmpEnvelope), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("encryptAndStore + loadAndDecrypt", () => {
  it("round-trips a private key through encryption", async () => {
    await encryptAndStore(VALID_KEY, PASSPHRASE, tmpEnvelope);
    const decrypted = await loadAndDecrypt(PASSPHRASE, tmpEnvelope);
    expect(decrypted).toBe(`0x${VALID_KEY}`);
  });

  it("accepts 0x-prefixed input", async () => {
    await encryptAndStore(`0x${VALID_KEY}`, PASSPHRASE, tmpEnvelope);
    const decrypted = await loadAndDecrypt(PASSPHRASE, tmpEnvelope);
    expect(decrypted).toBe(`0x${VALID_KEY}`);
  });

  it("rejects invalid private keys", async () => {
    await expect(encryptAndStore("not-a-key", PASSPHRASE, tmpEnvelope)).rejects.toThrow(/64 hex chars/);
  });

  it("rejects wrong passphrase", async () => {
    await encryptAndStore(VALID_KEY, PASSPHRASE, tmpEnvelope);
    await expect(loadAndDecrypt("wrong-passphrase", tmpEnvelope)).rejects.toThrow(/passphrase incorrect/);
  });

  it("envelopeExists returns false when no file", async () => {
    expect(await envelopeExists(tmpEnvelope)).toBe(false);
  });

  it("envelopeExists returns true after store", async () => {
    await encryptAndStore(VALID_KEY, PASSPHRASE, tmpEnvelope);
    expect(await envelopeExists(tmpEnvelope)).toBe(true);
  });

  it("envelope file has tight permissions (0600)", async () => {
    await encryptAndStore(VALID_KEY, PASSPHRASE, tmpEnvelope);
    const stat = await fs.stat(tmpEnvelope);
    // mode lower 9 bits should be 0600 (owner read/write, no group/other)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("plaintext key never appears in the on-disk envelope", async () => {
    await encryptAndStore(VALID_KEY, PASSPHRASE, tmpEnvelope);
    const raw = await fs.readFile(tmpEnvelope, "utf8");
    expect(raw).not.toContain(VALID_KEY);
    expect(raw).not.toContain(VALID_KEY.toUpperCase());
  });
});

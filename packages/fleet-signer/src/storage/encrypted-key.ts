import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * On-disk envelope for an encrypted private key.
 *
 * The actual private key never touches disk in plaintext. The structure on disk
 * is a JSON envelope with the salt + IV + ciphertext + auth tag. Decryption
 * requires the passphrase the operator entered at setup time.
 *
 * KDF: scrypt with N=2^17, r=8, p=1 (~256MB memory, ~1s on M-class hardware)
 * Cipher: AES-256-GCM (authenticated encryption)
 */
export interface EncryptedKeyEnvelope {
  /** Schema version. Bumped if envelope format changes. */
  version: 1;
  /** Hex salt for scrypt. */
  salt: string;
  /** Hex IV for AES-GCM. */
  iv: string;
  /** Hex ciphertext (the encrypted private key). */
  ciphertext: string;
  /** Hex GCM auth tag. */
  authTag: string;
  /** ISO timestamp this envelope was created. */
  createdAt: string;
}

const SCRYPT_PARAMS = { N: 1 << 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 32;

/** Default location for the on-disk envelope. */
export function defaultEnvelopePath(): string {
  return path.join(os.homedir(), ".fleet-signer", "key.enc");
}

/** Derive a 256-bit key from the passphrase + salt using scrypt. */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_PARAMS);
}

/**
 * Encrypt a private key with a passphrase and write the envelope to disk.
 *
 * @param privateKey hex private key (with or without 0x prefix)
 * @param passphrase operator's passphrase
 * @param envelopePath disk location for the envelope (default: ~/.fleet-signer/key.enc)
 */
export async function encryptAndStore(
  privateKey: string,
  passphrase: string,
  envelopePath: string = defaultEnvelopePath(),
): Promise<void> {
  const cleanedKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(cleanedKey)) {
    throw new Error("encryptAndStore: privateKey must be 64 hex chars (32 bytes)");
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const derivedKey = deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  const ciphertext = Buffer.concat([cipher.update(cleanedKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope: EncryptedKeyEnvelope = {
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(envelopePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(envelopePath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}

/**
 * Load and decrypt the on-disk envelope using the passphrase.
 *
 * @returns the private key as a 0x-prefixed hex string, ready to use with viem
 */
export async function loadAndDecrypt(
  passphrase: string,
  envelopePath: string = defaultEnvelopePath(),
): Promise<`0x${string}`> {
  const raw = await fs.readFile(envelopePath, "utf8");
  const envelope = JSON.parse(raw) as EncryptedKeyEnvelope;

  if (envelope.version !== 1) {
    throw new Error(`loadAndDecrypt: unsupported envelope version ${envelope.version}`);
  }

  const salt = Buffer.from(envelope.salt, "hex");
  const iv = Buffer.from(envelope.iv, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "hex");
  const authTag = Buffer.from(envelope.authTag, "hex");
  const derivedKey = deriveKey(passphrase, salt);

  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAuthTag(authTag);

  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("loadAndDecrypt: passphrase incorrect or envelope tampered");
  }

  if (!/^[0-9a-fA-F]{64}$/.test(plaintext)) {
    throw new Error("loadAndDecrypt: decrypted key has unexpected shape");
  }

  return `0x${plaintext}` as const;
}

/** Check whether an envelope file exists at the given path. */
export async function envelopeExists(envelopePath: string = defaultEnvelopePath()): Promise<boolean> {
  try {
    await fs.access(envelopePath);
    return true;
  } catch {
    return false;
  }
}

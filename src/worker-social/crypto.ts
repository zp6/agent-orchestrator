/**
 * RSA-SHA256 key management and HTTP Signature utilities (issue #1515).
 *
 * Keys are generated on first request and stored in SOCIAL_KV so no operator
 * action is needed to provision them. Race conditions on first boot are
 * harmless — the last writer wins and the actor JSON re-fetched.
 *
 * Uses the Web Crypto API available in Cloudflare Workers.
 */

import type { KVNamespace } from "./types.js";

const KV_PRIVATE_KEY = "crypto:privateKey";
const KV_PUBLIC_KEY_PEM = "crypto:publicKeyPem";

interface StoredKeyPair {
  privateKeyJwk: JsonWebKey;
  publicKeyPem: string;
}

// ── PEM conversion helpers ────────────────────────────────────────────────────

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Export an RSA public CryptoKey to PKCS#8 PEM format. */
async function exportPublicKeyPem(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", key);
  const b64 = arrayBufferToBase64(spki);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

/** Import a JWK private key for signing. */
async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ── Key bootstrap ─────────────────────────────────────────────────────────────

/** Get or generate the RSA key pair, cached in KV. */
export async function getOrCreateKeyPair(kv: KVNamespace): Promise<StoredKeyPair> {
  const cached = await kv.get(KV_PRIVATE_KEY);
  if (cached) {
    const stored = JSON.parse(cached) as StoredKeyPair;
    return stored;
  }

  // Generate new RSA-2048 key pair.
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKeyPem = await exportPublicKeyPem(keyPair.publicKey);

  const stored: StoredKeyPair = { privateKeyJwk, publicKeyPem };
  await kv.put(KV_PRIVATE_KEY, JSON.stringify(stored));
  await kv.put(KV_PUBLIC_KEY_PEM, publicKeyPem);

  return stored;
}

/** Get the public key PEM — faster path that skips private key parsing. */
export async function getPublicKeyPem(kv: KVNamespace): Promise<string> {
  const pem = await kv.get(KV_PUBLIC_KEY_PEM);
  if (pem) return pem;
  const pair = await getOrCreateKeyPair(kv);
  return pair.publicKeyPem;
}

// ── HTTP Signatures ───────────────────────────────────────────────────────────

/**
 * Build the `Signature` header value for a signed HTTP request.
 *
 * Implements the subset of HTTP Signatures used by ActivityPub federation:
 * (request-target), host, date, digest headers.
 */
export async function buildSignatureHeader(opts: {
  method: string;
  url: URL;
  date: string;
  digest: string;
  keyId: string;
  privateKeyJwk: JsonWebKey;
}): Promise<string> {
  const { method, url, date, digest, keyId, privateKeyJwk } = opts;
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const signingString = [
    `(request-target): ${requestTarget}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");

  const privateKey = await importPrivateKey(privateKeyJwk);
  const signatureBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingString),
  );
  const signatureB64 = arrayBufferToBase64(signatureBytes);

  return (
    `keyId="${keyId}",` +
    `algorithm="rsa-sha256",` +
    `headers="(request-target) host date digest",` +
    `signature="${signatureB64}"`
  );
}

/** Compute SHA-256 digest of a body string, returned as `SHA-256=<base64>`. */
export async function computeDigest(body: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `SHA-256=${arrayBufferToBase64(hash)}`;
}

/**
 * Deliver an ActivityPub activity to a remote inbox via HTTP Signatures.
 * Returns true on 2xx, false otherwise.
 */
export async function deliverActivity(opts: {
  inboxUrl: string;
  activity: object;
  keyId: string;
  privateKeyJwk: JsonWebKey;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { inboxUrl, activity, keyId, privateKeyJwk, fetchImpl = fetch } = opts;
  const body = JSON.stringify(activity);
  const url = new URL(inboxUrl);
  const date = new Date().toUTCString();
  const digest = await computeDigest(body);
  const signature = await buildSignatureHeader({
    method: "POST",
    url,
    date,
    digest,
    keyId,
    privateKeyJwk,
  });

  try {
    const response = await fetchImpl(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
        Accept: "application/activity+json",
        Date: date,
        Digest: digest,
        Signature: signature,
      },
      body,
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Export for testing
export { arrayBufferToBase64, base64ToArrayBuffer };

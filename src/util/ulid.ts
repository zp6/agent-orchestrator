/**
 * Minimal ULID generator that works without external dependencies.
 * Uses crypto.randomUUID() as entropy source.
 */

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    str = BASE32[now % 32] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => BASE32[b % 32])
    .join("");
}

export function ulid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

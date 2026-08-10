// ULID generator (Crockford base32, 48-bit time + 80-bit randomness).
// Dependency-free; run IDs must sort lexicographically by creation time
// (spec 08 §1).

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(10);
  let out = "";
  // 80 bits -> 16 chars of 5 bits each.
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

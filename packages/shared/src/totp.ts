/**
 * Time-based one-time passwords, computed here rather than fetched (feature 016).
 *
 * RFC 4226 (HOTP) and RFC 6238 (TOTP), with the Base32 and `otpauth://` handling
 * around them. Three properties are deliberate and load-bearing:
 *
 * **Synchronous.** `crypto.subtle` is promise-based, and a browser spends the
 * user activation a clipboard write needs on the first `await`. The notebook's
 * whole promise is "one press → the code is already on the clipboard", so the
 * arithmetic has to finish inside the click, not after it.
 *
 * **Dependency-free.** `@video-compressor/shared` has no runtime dependencies
 * and compiles into the agent as well as the web app. The algorithm is small,
 * frozen by its RFC, and pinned to the RFC's own published vectors in
 * `tests/totp.test.ts` — owning it is cheaper than owning a supply chain for it,
 * in a module whose subject is account access.
 *
 * **Environment-free.** No DOM API, no Node built-in, so the same code runs in
 * the browser, in the agent and in a plain Vitest process.
 */

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;

/** Why a pasted seed could not be stored. Each maps to its own message. */
export type TwoFactorSeedError = 'EMPTY' | 'NOT_BASE32' | 'TOO_SHORT' | 'URI_WITHOUT_SECRET';

export type ParsedSeed =
  { ok: true; secret: string; label: string | null } | { ok: false; error: TwoFactorSeedError };

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4226 puts the floor at 80 bits, which is 16 Base32 characters. Shorter is
 * not a key a service issued; it is a typo or half a paste.
 */
const MINIMUM_SEED_LENGTH = 16;

/**
 * Reads what a person pasted: either a bare seed or a whole enrolment link.
 *
 * Never throws and never guesses — a caller gets either a normalised secret it
 * can store or the specific rule that was broken, so the message on screen can
 * say which one.
 */
export function parseTwoFactorSeed(input: string): ParsedSeed {
  const raw = input.trim();
  if (raw === '') return { ok: false, error: 'EMPTY' };

  let candidate = raw;
  let label: string | null = null;
  if (/^otpauth:\/\//iu.test(raw)) {
    const link = readEnrolmentLink(raw);
    if (!link) return { ok: false, error: 'URI_WITHOUT_SECRET' };
    candidate = link.secret;
    label = link.label;
  }

  const normalised = normaliseSeed(candidate);
  if (normalised === '') return { ok: false, error: 'EMPTY' };
  if (!/^[A-Z2-7]+$/u.test(normalised)) return { ok: false, error: 'NOT_BASE32' };
  if (normalised.length < MINIMUM_SEED_LENGTH) return { ok: false, error: 'TOO_SHORT' };
  return { ok: true, secret: normalised, label };
}

/**
 * The six digits for `secret` at `atMs`, leading zeros and all.
 *
 * `secret` must already have been through `parseTwoFactorSeed`. A malformed one
 * throws rather than returning plausible digits: a wrong code that looks right
 * costs a person a locked account, and there is no caller that should be
 * passing an unvalidated seed here.
 */
export function generateTotp(secret: string, atMs: number = Date.now()): string {
  const key = decodeBase32(normaliseSeed(secret));
  if (!key || key.length === 0) throw new Error('TOTP_SECRET_INVALID');

  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
  const message = new Uint8Array(8);
  writeUint32BE(message, 0, Math.floor(counter / 0x1_0000_0000));
  writeUint32BE(message, 4, counter >>> 0);

  const digest = hmacSha1(key, message);
  return truncate(digest);
}

/** When the step containing `atMs` runs out — always strictly after `atMs`. */
export function totpStepEndsAt(atMs: number = Date.now()): number {
  const step = TOTP_STEP_SECONDS * 1000;
  return (Math.floor(atMs / step) + 1) * step;
}

// ---------------------------------------------------------------------------
// Reading what was pasted
// ---------------------------------------------------------------------------

/** Uppercase, no ASCII whitespace, no `=` padding — the shape services print, tidied. */
function normaliseSeed(value: string): string {
  return value.replace(/\s+/gu, '').replace(/=+$/u, '').toUpperCase();
}

/**
 * Pulls the secret and the account label out of an `otpauth://` link.
 *
 * `digits`, `period` and `algorithm` are read past rather than honoured: the
 * notebook ships the ubiquitous defaults and says so. Refusing a link that asks
 * for something else would leave the person unable to store the seed at all,
 * which helps nobody — storing it and being explicit about the parameters does.
 */
function readEnrolmentLink(raw: string): { secret: string; label: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  let secret: string | null = null;
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() === 'secret') secret = value;
  }
  if (!secret) return null;

  const path = parsed.pathname.replace(/^\//u, '');
  let label: string | null = null;
  if (path !== '') {
    try {
      label = decodeURIComponent(path);
    } catch {
      // A label that is not valid percent-encoding is still a label; the seed
      // is what matters, and the name field stays for the person to fill in.
      label = path;
    }
  }
  return { secret, label };
}

/** Base32 (RFC 4648, no padding) → bytes, or `null` on a character outside the alphabet. */
function decodeBase32(input: string): Uint8Array | null {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of input) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    value = ((value << 5) | index) >>> 0;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

const SHA1_BLOCK_BYTES = 64;

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function rotateLeft(value: number, by: number): number {
  return ((value << by) | (value >>> (32 - by))) >>> 0;
}

function sha1(message: Uint8Array): Uint8Array {
  // Pad to a multiple of 64 bytes: one 0x80 byte, zeros, then the length in
  // bits as a 64-bit big-endian integer.
  const padded = new Uint8Array(((message.length + 8) >> 6) * 64 + 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const bitLength = message.length * 8;
  writeUint32BE(padded, padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  writeUint32BE(padded, padded.length - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const words = new Array<number>(80);
  for (let chunk = 0; chunk < padded.length; chunk += SHA1_BLOCK_BYTES) {
    for (let index = 0; index < 16; index += 1) {
      const at = chunk + index * 4;
      words[index] =
        ((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) >>>
        0;
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + (f >>> 0) + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  writeUint32BE(digest, 0, h0);
  writeUint32BE(digest, 4, h1);
  writeUint32BE(digest, 8, h2);
  writeUint32BE(digest, 12, h3);
  writeUint32BE(digest, 16, h4);
  return digest;
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(SHA1_BLOCK_BYTES);
  block.set(key.length > SHA1_BLOCK_BYTES ? sha1(key) : key);

  const inner = new Uint8Array(SHA1_BLOCK_BYTES + message.length);
  const outer = new Uint8Array(SHA1_BLOCK_BYTES + 20);
  for (let index = 0; index < SHA1_BLOCK_BYTES; index += 1) {
    inner[index] = block[index] ^ 0x36;
    outer[index] = block[index] ^ 0x5c;
  }
  inner.set(message, SHA1_BLOCK_BYTES);
  outer.set(sha1(inner), SHA1_BLOCK_BYTES);
  return sha1(outer);
}

/** RFC 4226 dynamic truncation: the last nibble picks the four bytes to read. */
function truncate(digest: Uint8Array): string {
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

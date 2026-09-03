# Contract — `packages/shared/src/totp.ts`

A dependency-free, synchronous implementation of RFC 4226 (HOTP) and RFC 6238
(TOTP), plus the Base32 and `otpauth://` handling around them. No DOM API, no
Node built-in, no `crypto.subtle` — so it runs unchanged in the browser, in the
agent and in a plain Vitest process, and it can be called inside a click handler
without spending the user activation a clipboard write needs (see D2/D3 in
`research.md`).

## Public surface

```text
TOTP_DIGITS = 6
TOTP_STEP_SECONDS = 30

type TwoFactorSeedError = 'EMPTY' | 'NOT_BASE32' | 'TOO_SHORT' | 'URI_WITHOUT_SECRET'
type ParsedSeed = { ok: true; secret: string; label: string | null }
                | { ok: false; error: TwoFactorSeedError }

parseTwoFactorSeed(input: string): ParsedSeed
  Accepts a bare Base32 seed or a full `otpauth://` URI. Normalises by
  uppercasing, removing ASCII whitespace and stripping `=` padding. On a URI,
  reads the `secret` query parameter and returns the path label (URI-decoded,
  issuer prefix and all) as `label`, or `null` when there is none.
  Requires at least 16 Base32 characters — RFC 4226's 80-bit minimum.

generateTotp(secret: string, atMs?: number): string
  The six-digit code for `secret` at `atMs` (default `Date.now()`), with
  leading zeros preserved. `secret` must already be normalised — a caller
  passes what `parseTwoFactorSeed` returned.

totpStepEndsAt(atMs?: number): number
  Epoch milliseconds at which the step containing `atMs` ends, for the
  remaining-validity display (FR-017).
```

Everything below this line is module-private: `decodeBase32`, `sha1`,
`hmacSha1`, `dynamicTruncate`.

## Behaviour that the tests pin

**RFC 6238 appendix B**, with the ASCII secret `12345678901234567890`
(`GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` in Base32), SHA-1, 8 digits — the fixture
takes the last 6 for the shipped 6-digit configuration:

| Time (s) | 8-digit code |
| --- | --- |
| 59 | 94287082 |
| 1111111109 | 07081804 |
| 1111111111 | 14050471 |
| 1234567890 | 89005924 |
| 2000000000 | 69279037 |
| 20000000000 | 65353130 |

The last row is past 2038, so the counter must be computed in a way that does
not truncate to 32 bits.

**Base32 decoding**

- Lowercase input decodes identically to uppercase.
- Spaces, tabs and newlines anywhere are ignored — services print seeds in
  four-character groups.
- Trailing `=` padding is accepted and ignored.
- `0`, `1`, `8`, `9` and any non-alphabet character produce `NOT_BASE32`.
- A seed shorter than 16 characters produces `TOO_SHORT`.
- The empty string, or a string that is only whitespace, produces `EMPTY`.

**`otpauth://` parsing**

- `otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example`
  yields that secret and the label `Example:alice@example.com`.
- A URI with no `secret` parameter produces `URI_WITHOUT_SECRET`.
- A URI whose `secret` fails the Base32 rules produces that rule's error, not a
  URI error.
- `digits`, `period` and `algorithm` parameters are read but not honoured in
  this version: the seed is stored and the shipped defaults are used. A URI
  carrying non-default parameters is still accepted rather than rejected,
  because rejecting it would leave the person with no way to store the seed at
  all — the spec fixes the parameters as an assumption, and this is where that
  assumption is visible.

**Code generation**

- Leading zeros survive: a code of `001234` is six characters, not four.
- Two calls inside one 30-second step return the same digits; the first call in
  the next step returns different digits.
- `totpStepEndsAt` is strictly greater than the `atMs` handed to it, and lands
  on a multiple of 30 000 ms.

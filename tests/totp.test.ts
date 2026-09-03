import { describe, expect, it } from 'vitest';
import {
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  generateTotp,
  parseTwoFactorSeed,
  totpStepEndsAt
} from '../packages/shared/src/totp.js';

/**
 * The 2FA notebook computes its codes itself, so the only meaningful question is
 * whether it computes the same ones every other authenticator does. RFC 6238
 * publishes the answer, and these vectors are it.
 *
 * The published vectors are 8 digits; the notebook shows 6. That is not a
 * truncation of the string but the same arithmetic with a smaller modulus, and
 * `binary mod 10^6` is by definition the last six decimal digits of
 * `binary mod 10^8` — so the expectations below are the published values with
 * their first two digits dropped, and `005924` earns its leading zeros honestly.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"

const RFC_VECTORS: { seconds: number; eightDigits: string; sixDigits: string }[] = [
  { seconds: 59, eightDigits: '94287082', sixDigits: '287082' },
  { seconds: 1111111109, eightDigits: '07081804', sixDigits: '081804' },
  { seconds: 1111111111, eightDigits: '14050471', sixDigits: '050471' },
  { seconds: 1234567890, eightDigits: '89005924', sixDigits: '005924' },
  { seconds: 2000000000, eightDigits: '69279037', sixDigits: '279037' },
  { seconds: 20000000000, eightDigits: '65353130', sixDigits: '353130' }
];

describe('RFC 6238 test vectors', () => {
  it('ships the parameters the vectors assume', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_STEP_SECONDS).toBe(30);
  });

  for (const vector of RFC_VECTORS) {
    it(`matches the published code at ${vector.seconds}s`, () => {
      expect(generateTotp(RFC_SECRET, vector.seconds * 1000)).toBe(vector.sixDigits);
    });
  }

  it('keeps counting past 2038', () => {
    // The last vector sits beyond a 32-bit seconds counter. An implementation
    // that packs the step counter into 32 bits passes every other row here and
    // fails only this one, which is exactly why it is worth its own case.
    const late = RFC_VECTORS[RFC_VECTORS.length - 1];
    expect(late.seconds).toBeGreaterThan(2 ** 31);
    expect(generateTotp(RFC_SECRET, late.seconds * 1000)).toBe(late.sixDigits);
  });

  it('preserves leading zeros instead of shortening the code', () => {
    const code = generateTotp(RFC_SECRET, 1234567890 * 1000);
    expect(code).toBe('005924');
    expect(code).toHaveLength(6);
  });
});

describe('a code within its step', () => {
  const step = TOTP_STEP_SECONDS * 1000;
  const inside = 1_700_000_010_000;

  it('does not change while the step lasts', () => {
    const start = Math.floor(inside / step) * step;
    expect(generateTotp(RFC_SECRET, start)).toBe(generateTotp(RFC_SECRET, start + step - 1));
  });

  it('changes once the step ends', () => {
    const start = Math.floor(inside / step) * step;
    expect(generateTotp(RFC_SECRET, start)).not.toBe(generateTotp(RFC_SECRET, start + step));
  });
});

describe('the end of the current step', () => {
  it('lands on a 30-second boundary strictly after the moment given', () => {
    const step = TOTP_STEP_SECONDS * 1000;
    for (const moment of [0, 1, 15_000, 29_999, 30_000, 1_700_000_010_123]) {
      const end = totpStepEndsAt(moment);
      expect(end % step).toBe(0);
      expect(end).toBeGreaterThan(moment);
      expect(end - moment).toBeLessThanOrEqual(step);
    }
  });
});

describe('reading a seed', () => {
  const seed = 'JBSWY3DPEHPK3PXP';

  it('accepts a bare seed unchanged', () => {
    expect(parseTwoFactorSeed(seed)).toEqual({ ok: true, secret: seed, label: null });
  });

  it('accepts the shapes services actually print', () => {
    // Lowercase, four-character groups, and trailing padding all describe the
    // same key; a person pasting from a setup page should not have to tidy it.
    for (const written of ['jbswy3dpehpk3pxp', 'JBSW Y3DP EHPK 3PXP', 'JBSWY3DPEHPK3PXP====']) {
      const parsed = parseTwoFactorSeed(written);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.secret).toBe(seed);
    }
  });

  it('produces the same codes however the seed was written', () => {
    expect(generateTotp('jbswy3dpehpk3pxp'.toUpperCase(), 59_000)).toBe(generateTotp(seed, 59_000));
  });

  it('rejects an empty or blank field', () => {
    expect(parseTwoFactorSeed('')).toEqual({ ok: false, error: 'EMPTY' });
    expect(parseTwoFactorSeed('   \n\t ')).toEqual({ ok: false, error: 'EMPTY' });
  });

  it('rejects characters Base32 does not have', () => {
    // 0, 1, 8 and 9 are absent from the alphabet on purpose — they are the
    // characters people most often mistake for O, I and B.
    for (const written of ['JBSWY3DPEHPK3PX0', 'JBSWY3DPEHPK3PX1', 'JBSWY3DPEHPK3PX8', 'nope!']) {
      expect(parseTwoFactorSeed(written)).toEqual({ ok: false, error: 'NOT_BASE32' });
    }
  });

  it('rejects a key shorter than the 80 bits RFC 4226 requires', () => {
    expect(parseTwoFactorSeed('JBSWY3DPEHPK3PX')).toEqual({ ok: false, error: 'TOO_SHORT' });
  });
});

describe('reading an enrolment link', () => {
  it('takes the secret and the account label', () => {
    const parsed = parseTwoFactorSeed(
      'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example'
    );
    expect(parsed).toEqual({
      ok: true,
      secret: 'JBSWY3DPEHPK3PXP',
      label: 'Example:alice@example.com'
    });
  });

  it('decodes a percent-encoded label', () => {
    const parsed = parseTwoFactorSeed(
      'otpauth://totp/Big%20Co%3Aalice%40example.com?secret=JBSWY3DPEHPK3PXP'
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.label).toBe('Big Co:alice@example.com');
  });

  it('reports a link that carries no secret', () => {
    expect(parseTwoFactorSeed('otpauth://totp/Example?issuer=Example')).toEqual({
      ok: false,
      error: 'URI_WITHOUT_SECRET'
    });
  });

  it('reports the seed rule a link breaks, not a link error', () => {
    expect(parseTwoFactorSeed('otpauth://totp/Example?secret=nope!')).toEqual({
      ok: false,
      error: 'NOT_BASE32'
    });
    expect(parseTwoFactorSeed('otpauth://totp/Example?secret=JBSWY3DPEHPK3PX')).toEqual({
      ok: false,
      error: 'TOO_SHORT'
    });
  });

  it('accepts a link carrying non-default parameters rather than refusing the seed', () => {
    // The notebook shows 6 digits on a 30-second step and says so. Rejecting a
    // link because it asks for 8 would leave the person with no way to store
    // the seed at all, which is worse than storing it and being explicit.
    const parsed = parseTwoFactorSeed(
      'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256'
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('reports a link that is not a link', () => {
    expect(parseTwoFactorSeed('otpauth://')).toEqual({ ok: false, error: 'URI_WITHOUT_SECRET' });
  });
});

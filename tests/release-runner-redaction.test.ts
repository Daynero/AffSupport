import { describe, expect, it } from 'vitest';
import { createRedactor, redactText } from '../scripts/lib/release/redaction.mjs';

describe('release runner redaction', () => {
  it('removes private keys and token-like secrets before output', () => {
    expect(redactText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).not.toContain(
      'abc'
    );
    expect(redactText(`token ghp_${'a'.repeat(40)}`)).not.toContain('ghp_');
  });
  it('redacts a token split over chunks', () => {
    const redactor = createRedactor();
    const secret = `ghp_${'a'.repeat(40)}`;
    const result =
      redactor.write(secret.slice(0, 16)) + redactor.write(secret.slice(16)) + redactor.end();
    expect(result).not.toContain(secret);
  });
});

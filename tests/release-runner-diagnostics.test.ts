import { describe, expect, it } from 'vitest';
import { boundedDiagnostic, diagnosticFingerprint } from '../scripts/lib/release/diagnostics.mjs';

describe('bounded runner diagnostics', () => {
  it('caps output and redacts secrets before a handoff package exists', () => {
    const report = boundedDiagnostic({
      ok: false,
      lines: Array.from({ length: 200 }, () => `ghp_${'a'.repeat(40)}`),
      error: `failed ghp_${'b'.repeat(40)}`
    });
    expect(report.lines).toHaveLength(100);
    expect(JSON.stringify(report)).not.toContain('ghp_');
  });
  it('deduplicates an unchanged failure with a stable fingerprint', () => {
    const input = { stepId: 'publish', inputDigest: 'a'.repeat(64), error: 'timeout' };
    expect(diagnosticFingerprint(input)).toBe(diagnosticFingerprint(input));
  });
});

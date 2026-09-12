import { createHash } from 'node:crypto';
import { redactText } from './redaction.mjs';

const LIMITS = Object.freeze({ success: { lines: 20, bytes: 8192 }, failure: { lines: 100, bytes: 16384 } });

export function diagnosticFingerprint({ stepId, inputDigest, error }) {
  return createHash('sha256').update(`${stepId}\n${inputDigest}\n${redactText(error)}`).digest('hex');
}

/**
 * @param {{
 *   ok: boolean,
 *   lines?: readonly string[],
 *   error?: string | null,
 *   evidenceRefs?: readonly string[],
 *   resumePredicate?: string | null
 * }} report
 */
export function boundedDiagnostic({ ok, lines = [], error = null, evidenceRefs = [], resumePredicate = null }) {
  const limit = ok ? LIMITS.success : LIMITS.failure;
  const selected = [];
  let bytes = 0;
  for (const raw of lines) {
    const line = redactText(raw);
    const lineBytes = Buffer.byteLength(`${line}\n`);
    if (selected.length >= limit.lines || bytes + lineBytes > limit.bytes) break;
    selected.push(line); bytes += lineBytes;
  }
  return { ok, lines: selected, error: error ? redactText(error) : null, evidenceRefs, resumePredicate, bytes };
}

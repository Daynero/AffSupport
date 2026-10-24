import { describe, expect, it } from 'vitest';
import { validateLocalTarget } from '../scripts/acceptance/target.mjs';

const target = {
  kind: 'local',
  environment: 'beta',
  namespace: 'acceptance-campaign-001',
  marker: 'soty-acceptance',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
};

describe('acceptance target safety', () => {
  it('accepts only an explicit local beta namespace', () => {
    expect(validateLocalTarget(target)).toEqual({ ok: true });
  });
  it.each([
    { kind: 'hosted-acceptance' },
    { environment: 'production' },
    { namespace: '../production' },
    { marker: '' },
    { authUrl: 'https://example.supabase.co' },
    { authUrl: 'http://localhost.evil.test:54321' },
    { functionsUrl: 'http://127.0.0.1:9999/functions/v1' },
    { functionsUrl: 'http://127.0.0.1:54321/functions/v1?secret=bad' },
    { databaseUrl: 'postgresql://postgres:secret@example.com:54322/postgres' },
    { databaseUrl: 'postgresql://postgres:secret@127.0.0.1:54322/postgres?host=evil.test' },
    { databaseUrl: 'invalid' }
  ])('refuses an unsafe target without exposing credentials: %o', patch => {
    const result = validateLocalTarget({ ...target, ...patch });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('postgresql://');
  });
  it.each([null, [], {}, 'local'])('rejects malformed input %o', input => {
    expect(validateLocalTarget(input).ok).toBe(false);
  });
});

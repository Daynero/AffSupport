import { afterEach, expect, it, vi } from 'vitest';
import { launchFailure, launchFailureFrames } from '../supabase/functions/_shared/launch-failures';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { CatalogPublicationValidationError } from '../packages/shared/src/team/catalog-publication';
import { launchPublicationTimePassed } from '../apps/web/src/team/launches/launchPublicationTiming';

afterEach(() => vi.restoreAllMocks());

it('turns a shared publication validation failure into a non-retryable INVALID_INPUT, not a 500', () => {
  // Beta 2026-11-09: a reopened launch kept a past deferred-link time; generate answered 500
  // LAUNCH_INTERNAL_ERROR and the UI claimed the operation might still be running.
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mapped = launchFailure(new CatalogPublicationValidationError('time_in_past'));
  expect(mapped).toBeInstanceOf(TeamFunctionError);
  expect(mapped.code).toBe('INVALID_INPUT');
  expect(mapped.retryable).toBe(false);
  expect(log).not.toHaveBeenCalled();
});

it('logs only the class and code frames of an unknown failure, never its message', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const secret = new Error('refresh_token=abc123 https://drive.example/secret');
  secret.stack = [
    'Error: refresh_token=abc123',
    '    at invalid (file:///tmp/x/packages/shared/dist/team/catalog-publication.js:12:11)',
    '    at run (file:///tmp/x/supabase/functions/drive-ops/launches.ts:40:3)',
    '    at https://evil.example/?token=abc:1:1'
  ].join('\n');
  expect(launchFailure(secret).code).toBe('LAUNCH_INTERNAL_ERROR');
  const logged = JSON.stringify(log.mock.calls);
  expect(logged).not.toContain('abc123');
  expect(logged).not.toContain('evil.example');
  expect(launchFailureFrames(secret)).toEqual([
    'at invalid (file:///tmp/x/packages/shared/dist/team/catalog-publication.js:12:11)',
    'at …/drive-ops/launches.ts:40:3)'
  ]);
});

it('flags a scheduled link time that is not at least a minute ahead', () => {
  const now = Date.parse('2026-11-09T01:00:00Z');
  const at = (iso: string) => ({
    videoPublication: {
      mode: 'scheduled' as const,
      localDateTime: '2026-11-09T03:00',
      timeZone: 'Europe/Kyiv',
      resolvedOffset: '+02:00',
      dueAt: iso
    }
  });
  expect(launchPublicationTimePassed(at('2026-11-08T21:18:00.000Z'), now)).toBe(true);
  expect(launchPublicationTimePassed(at('2026-11-09T01:00:30.000Z'), now)).toBe(true);
  expect(launchPublicationTimePassed(at('2026-11-09T01:10:00.000Z'), now)).toBe(false);
  expect(launchPublicationTimePassed({ videoPublication: { mode: 'immediate' } }, now)).toBe(false);
  expect(launchPublicationTimePassed(null, now)).toBe(false);
  // A past time leaves dueAt empty in the form; it must still be reported as passed.
  const unresolved = (localDateTime: string) => ({
    videoPublication: {
      mode: 'scheduled' as const,
      localDateTime,
      timeZone: 'Europe/Kyiv',
      resolvedOffset: '',
      dueAt: ''
    }
  });
  expect(launchPublicationTimePassed(unresolved('2026-11-08T23:18'), now)).toBe(true);
  expect(launchPublicationTimePassed(unresolved('2026-11-09T05:00'), now)).toBe(false);
  expect(launchPublicationTimePassed(unresolved('not-a-time'), now)).toBe(false);
});

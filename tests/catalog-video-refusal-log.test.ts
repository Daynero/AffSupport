import { afterEach, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.ts';
import {
  describeCatalogVideoRefusal,
  logCatalogVideoRefusal
} from '../supabase/functions/drive-ops/catalog-video-refusal-log.ts';
import { admitCatalogVideoVariant } from '../supabase/functions/drive-ops/catalog-video-variant-admission.ts';

// Production 2026-11-26: `admit` answered 409 and every call after it 401, and only the
// database's own log could say which check had refused.
const set = '17600000-0000-4000-8000-000000000001';
afterEach(() => vi.restoreAllMocks());

it('names the step, the database function and its closed answer', () => {
  expect(
    describeCatalogVideoRefusal(
      'admit',
      'service_read_catalog_video_admission',
      { message: 'AUTH_REQUIRED', code: '42501' },
      { setId: set, index: 8 }
    )
  ).toEqual({
    step: 'admit',
    rpc: 'service_read_catalog_video_admission',
    answered: 'AUTH_REQUIRED',
    sqlstate: '42501',
    setId: set,
    index: 8
  });
  expect(
    describeCatalogVideoRefusal('foreground_load', null, new TeamFunctionError('AUTH_REQUIRED'))
  ).toMatchObject({ step: 'foreground_load', rpc: null, answered: 'AUTH_REQUIRED' });
});

it('never writes text the database composed, a ticket or a hash', () => {
  const described = describeCatalogVideoRefusal(
    'Foreground/../load',
    'drop table x; --',
    {
      message: 'duplicate key value violates unique constraint for owner@example.invalid',
      code: '23505',
      details: 'Key (token_hash)=(\\xdeadbeef) already exists.',
      hint: 'ticket abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
    },
    { setId: 'not-a-uuid ' + 'A'.repeat(43), index: -1 }
  );
  expect(described).toEqual({
    step: 'unknown',
    rpc: null,
    answered: 'UNRECOGNISED',
    sqlstate: '23505',
    setId: null,
    index: null
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logCatalogVideoRefusal('admit', 'service_read_catalog_video_admission', {
    message: 'secret-looking text',
    details: 'more of it'
  });
  const line = warn.mock.calls[0]!.join(' ');
  expect(line).toContain('[catalog-video] refused');
  expect(line).not.toContain('secret-looking');
  expect(line).not.toContain('more of it');
});

it('logs what the admission read was refused with before folding it into the agent code', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(
    admitCatalogVideoVariant(
      { rpc: async () => ({ data: null, error: { message: 'AUTH_REQUIRED', code: '42501' } }) },
      {
        setId: set,
        nativeInstanceId: '17600000-0000-4000-8000-000000000002',
        claimHash: 'never-logged-hash',
        protocolVersion: 1,
        index: 8,
        requestId: '17600000-0000-4000-8000-000000000003'
      },
      {
        restitchedFolder: async () => 'folder',
        startProcess: async () => ({ operationId: '17600000-0000-4000-8000-000000000004' })
      }
    )
  ).rejects.toMatchObject({ code: 'PROCESS_RESULT_UNCERTAIN' });
  const line = warn.mock.calls[0]!.join(' ');
  expect(line).toContain('"step":"admit"');
  expect(line).toContain('"rpc":"service_read_catalog_video_admission"');
  expect(line).toContain('"answered":"AUTH_REQUIRED"');
  expect(line).toContain('"index":8');
  expect(line).not.toContain('never-logged-hash');
});

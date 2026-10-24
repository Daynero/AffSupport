import { expect, it, vi } from 'vitest';
import { executeProviderFault } from '../scripts/acceptance/fault-effects.mjs';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';

it('feeds the supported rejected-page-token response through the actual Drive client parser', async () => {
  const control = vi.fn().mockResolvedValue({ ok: true });
  const transport = vi.fn();
  const drive = new GoogleDriveClient('synthetic-token-for-test-only', (input, init) =>
    executeProviderFault({ kind: 'expired_cursor' }, control, input, init, transport)
  );
  await expect(
    drive.listChildren({ parentId: 'own-qa-folder', pageToken: 'private-cursor' })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    retryable: true,
    details: { reason: 'PAGE_TOKEN_REJECTED' }
  });
  expect(transport).not.toHaveBeenCalled();
  expect(control.mock.calls.map(call => call[0])).toEqual(['claim', 'effect-start']);
});
it('feeds rate limiting through the real client and lets the next one-shot retry reach its transport', async () => {
  const control = vi
    .fn()
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValue({ ok: false });
  const transport = vi.fn(
    async () => new Response('{"files":[]}', { headers: { 'content-type': 'application/json' } })
  );
  const drive = new GoogleDriveClient('synthetic-token-for-test-only', (input, init) =>
    executeProviderFault({ kind: 'drive_429' }, control, input, init, transport)
  );
  await expect(drive.listChildren({ parentId: 'own-qa-folder' })).rejects.toMatchObject({
    code: 'RATE_LIMITED',
    retryable: true
  });
  expect(await drive.listChildren({ parentId: 'own-qa-folder' })).toMatchObject({ files: [] });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([
  ['https://oauth2.googleapis.com/token', { method: 'POST' }],
  ['https://www.googleapis.com/upload/drive/v3/files', { method: 'POST' }],
  ['https://www.googleapis.com/drive/v3/files/file-id?alt=media', {}],
  ['https://www.googleapis.com/drive/v3/files/file-id', {}],
  ['https://www.googleapis.com/drive/v3/changes?pageToken=cursor', {}],
  ['https://www.googleapis.com/drive/v3/files', {}]
])('does not inject a listing cursor fault into unrelated traffic %s', async (input, init) => {
  const control = vi.fn().mockResolvedValue({ ok: true });
  const response = new Response('unchanged');
  const transport = vi.fn().mockResolvedValue(response);
  expect(
    await executeProviderFault({ kind: 'expired_cursor' }, control, input, init, transport)
  ).toBe(response);
  expect(control).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledOnce();
});
it('preserves the transport response when clear wins between claim and effect start', async () => {
  const control = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
  const response = new Response('unchanged');
  const transport = vi.fn().mockResolvedValue(response);
  expect(
    await executeProviderFault(
      { kind: 'drive_429' },
      control,
      'https://www.googleapis.com/drive/v3/files',
      {},
      transport
    )
  ).toBe(response);
  expect(transport).toHaveBeenCalledOnce();
});

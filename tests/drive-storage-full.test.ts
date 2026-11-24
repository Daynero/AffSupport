import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import {
  asDriveRefusal,
  DriveRefusedProcess
} from '../apps/agent/src/team-bridge/catalog-variant-recovery';

// Production 2026-11-24: the owner's Google storage filled up mid-round. Every upload was answered
// 403 storageQuotaExceeded and the person read «У вас немає дозволу на цю дію».
function refusal(reason: string) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: { code: 403, errors: [{ reason, message: 'synthetic' }] } }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
  );
}
function upload(request: ReturnType<typeof vi.fn>) {
  return new GoogleDriveClient(
    'synthetic-token-for-test',
    request as unknown as typeof fetch
  ).startResumableUpload({
    name: 'result.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    parentId: 'parent'
  });
}

it('names a full Google storage instead of a missing permission', async () => {
  await expect(upload(refusal('storageQuotaExceeded'))).rejects.toThrow('DRIVE_STORAGE_FULL');
});

it('keeps an ordinary Drive refusal a missing permission', async () => {
  await expect(upload(refusal('insufficientFilePermissions'))).rejects.toThrow('PERMISSION_DENIED');
});

it("marks Drive's refusal of one video's work apart from this computer's permission", () => {
  for (const code of ['PERMISSION_DENIED', 'DRIVE_STORAGE_FULL', 'NEEDS_REAUTH']) {
    const marked = asDriveRefusal(new Error(code));
    expect(marked).toBeInstanceOf(DriveRefusedProcess);
    expect((marked as Error).message).toBe(code);
  }
  const other = new Error('PROCESS_RESULT_UNCERTAIN');
  expect(asDriveRefusal(other)).toBe(other);
  const stopped = new AbortController();
  stopped.abort(new Error('PERMISSION_DENIED'));
  const during = new Error('PERMISSION_DENIED');
  expect(asDriveRefusal(during, stopped.signal)).toBe(during);
});

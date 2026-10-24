import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive.js';

const reservedId = 'preallocated-provider-file';
const session = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=synthetic';

it('requests exactly one provider-generated new-file identity without creating a file', async () => {
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files/generateIds');
    expect(url.searchParams.get('count')).toBe('1');
    expect(url.searchParams.get('space')).toBe('drive');
    expect(url.searchParams.get('type')).toBe('files');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    return Response.json({ ids: [reservedId] });
  });
  const drive = new GoogleDriveClient('synthetic-access-token', request as typeof fetch);
  expect(await drive.generateFileId()).toBe(reservedId);
  expect(request).toHaveBeenCalledOnce();
});

it.each([null, {}, { ids: [] }, { ids: ['a', 'b'] }, { ids: [''] }, { ids: ['../other'] }])(
  'refuses an ambiguous or malformed provider identity: %j',
  async payload => {
    const request = vi.fn(async () => Response.json(payload));
    const drive = new GoogleDriveClient('synthetic-access-token', request as typeof fetch);
    await expect(drive.generateFileId()).rejects.toThrow('INVALID_RESPONSE');
    expect(request).toHaveBeenCalledOnce();
  }
);

it('uses the reserved identity in a new upload POST while retaining its ownership marker', async () => {
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(input)).pathname).toBe('/upload/drive/v3/files');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      id: reservedId,
      name: 'result.mp4',
      mimeType: 'video/mp4',
      parents: ['own-parent'],
      appProperties: { 'soty.process.output': 'synthetic-nonce' }
    });
    return new Response(null, { headers: { location: session } });
  });
  const drive = new GoogleDriveClient('synthetic-access-token', request as typeof fetch);
  await drive.startResumableUpload({
    name: 'result.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    parentId: 'own-parent',
    newFileId: reservedId,
    appProperties: { 'soty.process.output': 'synthetic-nonce' }
  });
  expect(request).toHaveBeenCalledOnce();
});

it('cannot combine a reserved new-file identity with an overwrite target', async () => {
  const request = vi.fn();
  const drive = new GoogleDriveClient('synthetic-access-token', request as typeof fetch);
  await expect(
    drive.startResumableUpload({
      name: 'result.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      parentId: 'own-parent',
      newFileId: reservedId,
      existingFileId: 'original-file'
    })
  ).rejects.toThrow('INVALID_INPUT');
  expect(request).not.toHaveBeenCalled();
});

it.each(['', '../original', 'id\nheader', 'x'.repeat(201)])(
  'rejects an invalid reserved identity before any provider write: %j',
  async newFileId => {
    const request = vi.fn();
    const drive = new GoogleDriveClient('synthetic-access-token', request as typeof fetch);
    await expect(
      drive.startResumableUpload({
        name: 'result.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 10,
        parentId: 'own-parent',
        newFileId
      })
    ).rejects.toThrow('INVALID_INPUT');
    expect(request).not.toHaveBeenCalled();
  }
);

it('never retries a conflicting reserved identity as an overwrite or a different new file', async () => {
  const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).id).toBe(reservedId);
    return Response.json({ error: { code: 409 } }, { status: 409 });
  });
  const drive = new GoogleDriveClient('synthetic-access-token', request as typeof fetch);
  await expect(
    drive.startResumableUpload({
      name: 'result.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      parentId: 'own-parent',
      newFileId: reservedId
    })
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});

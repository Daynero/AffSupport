import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive.js';

const metadata = {
  id: 'owned-file',
  title: 'output.mp4',
  mimeType: 'video/mp4',
  etag: '"provider-revision-1"',
  parents: [{ id: 'owned-parent' }],
  labels: { trashed: false },
  fileSize: '123',
  md5Checksum: 'a'.repeat(32),
  ownedByMe: true,
  capabilities: { canTrash: true },
  properties: [
    { key: 'soty.process.output', value: 'private-nonce', visibility: 'PRIVATE' },
    { key: 'untrusted-public', value: 'ignored', visibility: 'PUBLIC' }
  ]
};

it('reads ownership and ETag in one v2 response with the caller deadline', async () => {
  const signal = AbortSignal.timeout(1000);
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/drive/v2/files/owned-file');
    expect(url.searchParams.get('fields')).toContain('etag');
    expect(url.searchParams.get('fields')).toContain('properties');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(init?.signal).toBe(signal);
    return Response.json(metadata);
  });
  const client = new GoogleDriveClient('synthetic-access-token', fetchImpl as typeof fetch);
  expect(await client.getProcessOutputRecoveryFile('owned-file', signal)).toEqual({
    id: 'owned-file',
    name: 'output.mp4',
    mimeType: 'video/mp4',
    etag: metadata.etag,
    parents: ['owned-parent'],
    trashed: false,
    size: 123,
    checksum: 'a'.repeat(32),
    ownedByMe: true,
    driveId: null,
    canTrash: true,
    appProperties: { 'soty.process.output': 'private-nonce' }
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  { etag: undefined },
  { etag: 'unquoted' },
  { etag: '"header\r\ninjection"' },
  { id: 'different-file' },
  { parents: [{ wrong: true }] },
  { labels: {} },
  { fileSize: '9007199254740992' },
  { md5Checksum: 'not-md5' },
  { properties: [...metadata.properties, metadata.properties[0]] }
])('refuses incomplete or ambiguous ownership metadata: %j', async patch => {
  const client = new GoogleDriveClient('synthetic-access-token', async () =>
    Response.json({ ...metadata, ...patch })
  );
  await expect(
    client.getProcessOutputRecoveryFile('owned-file', AbortSignal.timeout(1000))
  ).rejects.toThrow('INVALID_RESPONSE');
});

it('permits incomplete upload size/checksum as explicit unknown, never fabricated identity', async () => {
  const client = new GoogleDriveClient('synthetic-access-token', async () =>
    Response.json({ ...metadata, fileSize: undefined, md5Checksum: undefined })
  );
  expect(
    await client.getProcessOutputRecoveryFile('owned-file', AbortSignal.timeout(1000))
  ).toMatchObject({ size: null, checksum: null });
});

it('trashes only the exact file using a v2 conditional PATCH and does not claim readback', async () => {
  const signal = AbortSignal.timeout(1000);
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(input)).pathname).toBe('/drive/v2/files/owned-file');
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('if-match')).toBe(metadata.etag);
    expect(JSON.parse(String(init?.body))).toEqual({ labels: { trashed: true } });
    expect(init?.signal).toBe(signal);
    return Response.json({ id: 'owned-file', labels: { trashed: true } });
  });
  const client = new GoogleDriveClient('synthetic-access-token', fetchImpl as typeof fetch);
  await expect(
    client.trashProcessOutputConditionally('owned-file', metadata.etag, signal)
  ).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('treats a provider precondition rejection as changed source without retry or fallback', async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ error: { errors: [{ reason: 'conditionNotMet' }] } }, { status: 412 })
  );
  const client = new GoogleDriveClient('synthetic-access-token', fetchImpl);
  await expect(
    client.trashProcessOutputConditionally('owned-file', metadata.etag, AbortSignal.timeout(1000))
  ).rejects.toThrow('SOURCE_CHANGED');
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each(['', '*', 'unquoted', '"a\r\nb"'])(
  'refuses an unsafe mutation ETag before fetching: %j',
  async etag => {
    const fetchImpl = vi.fn();
    const client = new GoogleDriveClient('synthetic-access-token', fetchImpl);
    await expect(
      client.trashProcessOutputConditionally('owned-file', etag, AbortSignal.timeout(1000))
    ).rejects.toThrow('INVALID_INPUT');
    expect(fetchImpl).not.toHaveBeenCalled();
  }
);

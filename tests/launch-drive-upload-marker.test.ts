import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import { launchDriveMetadata } from './fixtures/launches';

it('passes the private Launch ownership marker when opening a new resumable upload', async () => {
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'result.mp4',
      mimeType: 'video/mp4',
      parents: ['parent'],
      appProperties: { 'soty.launch.restitch.operation': 'operation-id' }
    });
    return new Response(null, {
      status: 200,
      headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' }
    });
  });
  const drive = new GoogleDriveClient(
    'synthetic-token-for-test',
    request as unknown as typeof fetch
  );
  await drive.startResumableUpload({
    name: 'result.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    parentId: 'parent',
    appProperties: { 'soty.launch.restitch.operation': 'operation-id' }
  });
  expect(request).toHaveBeenCalledOnce();
});

it('does not allow a marked upload to overwrite an existing file', async () => {
  const request = vi.fn();
  const drive = new GoogleDriveClient(
    'synthetic-token-for-test',
    request as unknown as typeof fetch
  );
  await expect(
    drive.startResumableUpload({
      name: 'result.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      parentId: 'parent',
      existingFileId: 'existing',
      appProperties: { 'soty.launch.restitch.operation': 'operation-id' }
    })
  ).rejects.toThrow('INVALID_INPUT');
  expect(request).not.toHaveBeenCalled();
});

it('looks up only an exact marked video in the expected parent and rejects truncated results', async () => {
  const file = {
    ...launchDriveMetadata(),
    id: 'video-result',
    mimeType: 'video/mp4',
    appProperties: { 'soty.launch.restitch.operation': 'operation-id' }
  };
  const request = vi.fn(async (url: string | URL | Request) => {
    const query = new URL(String(url)).searchParams.get('q');
    expect(query).toContain("value='operation-id'");
    expect(query).toContain("'parent' in parents");
    return Response.json({ files: [file], incompleteSearch: false });
  });
  const drive = new GoogleDriveClient(
    'synthetic-token-for-test',
    request as unknown as typeof fetch
  );
  expect(
    await drive.findLaunchRestitchFiles({ operationId: 'operation-id', parentId: 'parent' })
  ).toHaveLength(1);
  request.mockImplementationOnce(async () =>
    Response.json({ files: [file], nextPageToken: 'another-page' })
  );
  await expect(
    drive.findLaunchRestitchFiles({ operationId: 'operation-id', parentId: 'parent' })
  ).rejects.toThrow('LAUNCH_RESULT_UNCERTAIN');
  request.mockImplementationOnce(async () => Response.json({ files: [file], nextPageToken: 0 }));
  await expect(
    drive.findLaunchRestitchFiles({ operationId: 'operation-id', parentId: 'parent' })
  ).rejects.toThrow('LAUNCH_RESULT_UNCERTAIN');
  request.mockImplementationOnce(async () => Response.json({ files: [file, file] }));
  await expect(
    drive.findLaunchRestitchFiles({ operationId: 'operation-id', parentId: 'parent' })
  ).rejects.toThrow('LAUNCH_RESULT_UNCERTAIN');
});

it('rejects a malformed catalog marker page rather than assuming the lookup is complete', async () => {
  const request = vi.fn(async () => Response.json({ files: [], nextPageToken: '' }));
  const drive = new GoogleDriveClient(
    'synthetic-token-for-test',
    request as unknown as typeof fetch
  );
  await expect(
    drive.findCatalogIntentFiles({ marker: 'catalog-intent', parentId: 'parent' })
  ).rejects.toThrow('LAUNCH_RESULT_UNCERTAIN');
});

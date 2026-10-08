import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveClient, proveLiveAncestry } from '../supabase/functions/_shared/drive';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  catalogFile,
  DRIVE_PAGE_TOKEN_BODY,
  DRIVE_PERMISSION_BODY,
  DRIVE_RATE_LIMIT_BODY,
  shortcutFile
} from './fixtures/catalog-sync';

/**
 * 028 — three Drive answers used to kill the canonical job for good: a 403
 * that only meant "slow down", a 400 for an expired page token, and a
 * shortcut among the changes. None of them is a loss of access.
 */

const TOKEN = 'ya29.test-access-token-with-enough-length';

function driveWith(status: number, body: unknown): GoogleDriveClient {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
  );
  return new GoogleDriveClient(TOKEN, fetchImpl as unknown as typeof fetch);
}

async function failure(run: () => Promise<unknown>): Promise<TeamFunctionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TeamFunctionError) return error;
    throw error;
  }
  throw new Error('expected the Drive call to fail');
}

describe('Drive error mapping', () => {
  it('403 rate limit maps to RATE_LIMITED retryable', async () => {
    const error = await failure(() =>
      driveWith(403, DRIVE_RATE_LIMIT_BODY).listChildren({ parentId: 'root' })
    );
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
  });

  it('403 permission maps to PERMISSION_DENIED', async () => {
    const error = await failure(() => driveWith(403, DRIVE_PERMISSION_BODY).getFile('file'));
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.retryable).toBe(false);
  });

  it('400 pageToken maps to INVALID_INPUT with PAGE_TOKEN_REJECTED so the engine starts a fresh generation', async () => {
    const error = await failure(() =>
      driveWith(400, DRIVE_PAGE_TOKEN_BODY).listChildren({ parentId: 'root', pageToken: 'stale' })
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.retryable).toBe(true);
    expect(error.details?.reason).toBe('PAGE_TOKEN_REJECTED');
  });

  it('other 400s stay a permanent DRIVE_UNAVAILABLE', async () => {
    const error = await failure(() =>
      driveWith(400, { error: { message: 'Bad Request', errors: [] } }).getFile('file')
    );
    expect(error.code).toBe('DRIVE_UNAVAILABLE');
    expect(error.retryable).toBe(false);
  });

  it('a body that is not JSON does not change the mapping', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 403 }));
    const drive = new GoogleDriveClient(TOKEN, fetchImpl as unknown as typeof fetch);
    const error = await failure(() => drive.getFile('file'));
    expect(error.code).toBe('PERMISSION_DENIED');
  });
});

describe('a shortcut in the tree', () => {
  const files = new Map([
    ['shortcut', shortcutFile({ parents: ['folder'] })],
    [
      'folder',
      catalogFile({
        id: 'folder',
        parents: ['root'],
        mimeType: 'application/vnd.google-apps.folder'
      })
    ]
  ]);
  const client = { getFile: vi.fn(async (id: string) => files.get(id)!) };

  it('is refused as an authorization target by default', async () => {
    const error = await failure(() =>
      proveLiveAncestry({ client, fileId: 'shortcut', rootFolderId: 'root' })
    );
    expect(error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it('is placed by its own parents when the catalog asks', async () => {
    const placed = await proveLiveAncestry({
      client,
      fileId: 'shortcut',
      rootFolderId: 'root',
      allowShortcutTarget: true
    });
    expect(placed.id).toBe('shortcut');
    expect(client.getFile).toHaveBeenCalledWith('folder');
  });
});

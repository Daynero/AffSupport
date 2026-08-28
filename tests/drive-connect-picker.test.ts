import { describe, expect, it, vi } from 'vitest';
import {
  DRIVE_FILE_SCOPE,
  DRIVE_RESTRICTED_SCOPE,
  assertScopesAllowed,
  resolveDriveScopes,
  restrictedScopeApproval,
  restrictedScopeGate
} from '../supabase/functions/_shared/scopes';
import { executeDriveConnectCommand } from '../supabase/functions/drive-connect/handler';
import { completeDriveOAuthCallback } from '../supabase/functions/drive-oauth-callback/handler';

/**
 * Feature 011 (T022): the authorization asks for drive.file only, the
 * restricted scope solely on recorded approval and never on production
 * without it; a root picked in Google's chooser connects in one step.
 */

const production = 'https://soty.pp.ua';
const signals = { siteUrl: 'http://127.0.0.1:5173', requestOrigin: 'http://127.0.0.1:5173' };

function driveFolder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'picked-folder',
    name: 'Campaigns',
    mimeType: 'application/vnd.google-apps.folder',
    parents: [],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: true,
      canAddChildren: true,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: true
    },
    size: null,
    modifiedAt: null,
    version: null,
    checksum: null,
    ...overrides
  };
}

describe('Drive scopes (011)', () => {
  it('asks for drive.file alone unless approval is recorded', () => {
    expect(resolveDriveScopes({})).toEqual([DRIVE_FILE_SCOPE]);
    expect(resolveDriveScopes({ DRIVE_RESTRICTED_SCOPE_APPROVED: 'false' })).toEqual([
      DRIVE_FILE_SCOPE
    ]);
    expect(resolveDriveScopes({ DRIVE_RESTRICTED_SCOPE_APPROVED: 'true' })).toEqual([
      DRIVE_FILE_SCOPE,
      DRIVE_RESTRICTED_SCOPE
    ]);
    expect(restrictedScopeApproval('TRUE')).toBe('approved');
    expect(restrictedScopeApproval(undefined)).toBe('not_approved');
    expect(restrictedScopeApproval('yes')).toBe('invalid');
  });

  it('refuses a restricted scope on the production origin without approval, and any invalid setting', () => {
    expect(restrictedScopeGate([DRIVE_FILE_SCOPE], true, 'not_approved')).toBeNull();
    expect(
      restrictedScopeGate([DRIVE_FILE_SCOPE, DRIVE_RESTRICTED_SCOPE], false, 'not_approved')
    ).toBeNull();
    expect(
      restrictedScopeGate([DRIVE_FILE_SCOPE, DRIVE_RESTRICTED_SCOPE], true, 'not_approved')
    ).toBe('RESTRICTED_SCOPE_NOT_APPROVED');
    expect(
      restrictedScopeGate([DRIVE_FILE_SCOPE, DRIVE_RESTRICTED_SCOPE], true, 'approved')
    ).toBeNull();
    expect(restrictedScopeGate([DRIVE_FILE_SCOPE], false, 'invalid')).toBe(
      'RESTRICTED_SCOPE_NOT_APPROVED'
    );
    expect(() => assertScopesAllowed([DRIVE_RESTRICTED_SCOPE], true, 'not_approved')).toThrowError(
      expect.objectContaining({ code: 'RESTRICTED_SCOPE_NOT_APPROVED' })
    );
    expect(() => assertScopesAllowed([DRIVE_FILE_SCOPE], true, 'not_approved')).not.toThrow();
  });
});

describe('choose_root (011)', () => {
  it('validates the picked folder, persists it and queues the walk in one step', async () => {
    const persistConnection = vi.fn().mockResolvedValue({ connectionId: 'connection-1' });
    const enqueueInitialSync = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const result = await executeDriveConnectCommand(
      { action: 'choose_root', teamId: 'team-1', folderId: 'picked-folder' },
      {
        oauthMode: 'testing',
        signals,
        getRoot: vi.fn().mockResolvedValue(driveFolder()),
        persistConnection,
        enqueueInitialSync
      }
    );
    expect(result).toMatchObject({
      state: 'connected',
      connectionId: 'connection-1',
      syncJobId: 'job-1',
      folder: { id: 'picked-folder', name: 'Campaigns', driveKind: 'my_drive' }
    });
    expect(persistConnection).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', id: 'picked-folder' })
    );
    expect(enqueueInitialSync).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-1', rootFolderId: 'picked-folder' })
    );
  });

  it('refuses a shortcut, a file and a folder it cannot list — and the gate on production', async () => {
    const dependencies = (metadata: ReturnType<typeof driveFolder>) => ({
      oauthMode: 'testing',
      signals,
      getRoot: vi.fn().mockResolvedValue(metadata),
      persistConnection: vi.fn(),
      enqueueInitialSync: vi.fn()
    });
    await expect(
      executeDriveConnectCommand(
        { action: 'choose_root', teamId: 'team-1', folderId: 'x' },
        dependencies(
          driveFolder({ mimeType: 'application/vnd.google-apps.shortcut', shortcutTargetId: 'y' })
        )
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    await expect(
      executeDriveConnectCommand(
        { action: 'choose_root', teamId: 'team-1', folderId: 'x' },
        dependencies(driveFolder({ mimeType: 'image/png' }))
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      executeDriveConnectCommand(
        { action: 'choose_root', teamId: 'team-1', folderId: 'x' },
        dependencies(
          driveFolder({ capabilities: { ...driveFolder().capabilities, canListChildren: false } })
        )
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      executeDriveConnectCommand(
        { action: 'choose_root', teamId: 'team-1', folderId: 'x' },
        { ...dependencies(driveFolder()), signals: { ...signals, requestOrigin: production } }
      )
    ).rejects.toMatchObject({ code: 'OAUTH_APPROVAL_REQUIRED' });
  });
});

describe('OAuth callback scope (011)', () => {
  it('stores what Google granted, and drive.file when the grant omits the scope', async () => {
    const storeCredential = vi.fn().mockResolvedValue({ credentialId: 'credential-1' });
    const dependencies = {
      peekTransaction: vi.fn().mockResolvedValue({
        id: 'transaction-id',
        origin: signals.siteUrl,
        codeVerifier: 'pkce-verifier'
      }),
      consumeTransaction: vi.fn().mockResolvedValue({
        id: 'transaction-id',
        teamId: 'team-1',
        actorId: 'actor-1',
        codeVerifier: 'pkce-verifier',
        credentialId: null
      }),
      exchangeCode: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' }),
      verifyPrincipal: vi
        .fn()
        .mockResolvedValue({ permissionId: 'perm', email: 'owner@example.test' }),
      storeCredential,
      markNeedsReauth: vi.fn()
    };
    await completeDriveOAuthCallback(
      { code: 'code', state: 'state', oauthMode: 'testing', signals },
      dependencies
    );
    expect(storeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ scope: DRIVE_FILE_SCOPE })
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { evaluateDriveOAuthGate } from '../supabase/functions/_shared/auth';
import {
  refreshGoogleAccessToken,
  type DriveCredential
} from '../supabase/functions/_shared/credentials';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  executeDriveConnectCommand,
  validateRootCandidate
} from '../supabase/functions/drive-connect/handler';
import { evaluateTeamProviderReadiness } from '../supabase/functions/drive-connect/readiness';
import { completeDriveOAuthCallback } from '../supabase/functions/drive-oauth-callback/handler';
import { runInitialSyncSlice } from '../supabase/functions/catalog-sync/worker';

const productionOrigin = 'https://wishly-app.pages.dev';
const localSignals = {
  siteUrl: 'http://127.0.0.1:5173',
  requestOrigin: 'http://127.0.0.1:5173',
  transactionOrigin: 'http://127.0.0.1:5173'
};

const folderCapabilities = {
  canDownload: true,
  canListChildren: true,
  canAddChildren: true,
  canRename: true,
  canMoveItemWithinDrive: true,
  canMoveItemOutOfDrive: true,
  canModifyContent: true,
  canTrash: true,
  canUntrash: true
};

function driveFolder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'root-folder',
    name: 'Team media',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['drive-root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: folderCapabilities,
    size: null,
    modifiedAt: '2026-08-01T12:00:00.000Z',
    version: '7',
    checksum: null,
    ...overrides
  };
}

describe('Drive OAuth release gate', () => {
  it.each([
    ['disabled', localSignals, false],
    [undefined, localSignals, false],
    ['unexpected', localSignals, false],
    ['testing', localSignals, true],
    ['verified', localSignals, true],
    ['disabled', { ...localSignals, siteUrl: productionOrigin }, false],
    ['testing', { ...localSignals, siteUrl: productionOrigin }, false],
    ['testing', { ...localSignals, requestOrigin: productionOrigin }, false],
    ['testing', { ...localSignals, transactionOrigin: productionOrigin }, false],
    ['verified', { ...localSignals, siteUrl: productionOrigin }, true]
  ] as const)('mode %s with signals %o has allowed=%s', (mode, signals, allowed) => {
    expect(evaluateDriveOAuthGate(mode, signals).allowed).toBe(allowed);
  });

  it('rejects before OAuth state, provider, Vault, or connection side effects', async () => {
    const effects = {
      createOAuthTransaction: vi.fn(),
      exchangeCode: vi.fn(),
      writeCredential: vi.fn(),
      persistConnection: vi.fn()
    };

    await expect(
      executeDriveConnectCommand(
        { action: 'start', teamId: '20000000-0000-4000-8000-000000000001' },
        {
          oauthMode: 'testing',
          signals: { ...localSignals, requestOrigin: productionOrigin },
          ...effects
        }
      )
    ).rejects.toMatchObject({ code: 'OAUTH_APPROVAL_REQUIRED' });

    expect(Object.values(effects).every(effect => effect.mock.calls.length === 0)).toBe(true);
  });

  it('reports production ready only when every Team Workspace provider is configured', () => {
    const signals = { siteUrl: productionOrigin, requestOrigin: productionOrigin };
    const complete = {
      DRIVE_OAUTH_MODE: 'verified',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_REDIRECT_URI: 'https://project.supabase.co/functions/v1/drive-oauth-callback',
      RESEND_API_KEY: 'resend-api-key',
      INVITE_EMAIL_FROM: 'Wishly <team@example.test>',
      CATALOG_SYNC_SECRET: 'c'.repeat(32)
    };

    expect(evaluateTeamProviderReadiness(complete, signals)).toMatchObject({
      ready: true,
      oauthMode: 'verified',
      services: {
        googleDrive: true,
        invitationEmail: true,
        directMemberAdd: false,
        catalogWorker: true
      },
      memberOnboarding: 'email_invitation'
    });
    expect(
      evaluateTeamProviderReadiness(
        { ...complete, GOOGLE_CLIENT_SECRET: undefined, RESEND_API_KEY: undefined },
        signals
      )
    ).toMatchObject({
      ready: false,
      services: {
        googleDrive: false,
        invitationEmail: false,
        directMemberAdd: false,
        catalogWorker: true
      },
      memberOnboarding: 'unavailable'
    });
    expect(
      evaluateTeamProviderReadiness(
        { ...complete, RESEND_API_KEY: undefined, TEAM_DIRECT_ADD_MODE: 'testing' },
        signals
      )
    ).toMatchObject({
      ready: true,
      fullProviderReady: false,
      services: { invitationEmail: false, directMemberAdd: true },
      memberOnboarding: 'direct_add_testing'
    });
    expect(
      evaluateTeamProviderReadiness({ ...complete, DRIVE_OAUTH_MODE: 'testing' }, signals)
    ).toMatchObject({ ready: false, oauthMode: 'testing' });
  });
});

describe('server-side folder browser and root validation', () => {
  it('paginates folders with My Drive and Shared Drive safety flags without leaking a token', async () => {
    const requests: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requests.push(new URL(String(input)));
      return new Response(
        JSON.stringify({ files: [driveFolder({ id: 'child-folder' })], nextPageToken: 'page-2' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const client = new GoogleDriveClient(
      'access-token-with-safe-length',
      fetchImpl as typeof fetch
    );

    const myDrive = await client.listFolders({ parentId: 'root-folder' });
    const sharedDrive = await client.listFolders({
      parentId: 'shared-root',
      pageToken: 'page-1',
      driveId: 'shared-drive-id'
    });

    expect(myDrive).toMatchObject({ nextPageToken: 'page-2' });
    expect(sharedDrive.files[0]?.id).toBe('child-folder');
    expect(requests[0]?.searchParams.get('supportsAllDrives')).toBe('true');
    expect(requests[0]?.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(requests[1]?.searchParams.get('corpora')).toBe('drive');
    expect(requests[1]?.searchParams.get('driveId')).toBe('shared-drive-id');
    expect(JSON.stringify({ myDrive, sharedDrive })).not.toContain('access-token');
  });

  it('accepts My Drive and Shared Drive folders but rejects shortcut roots', () => {
    expect(validateRootCandidate(driveFolder())).toMatchObject({ driveKind: 'my_drive' });
    expect(validateRootCandidate(driveFolder({ driveId: 'shared-drive-id' }))).toMatchObject({
      driveKind: 'shared_drive'
    });
    expect(() =>
      validateRootCandidate(
        driveFolder({
          mimeType: 'application/vnd.google-apps.shortcut',
          shortcutTargetId: 'outside-root'
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA' }));
  });
});

describe('OAuth callback custody', () => {
  it('rechecks a mode change before consume/exchange/storage', async () => {
    const consumeTransaction = vi.fn();
    const exchangeCode = vi.fn();
    const storeCredential = vi.fn();

    const result = await completeDriveOAuthCallback(
      { code: 'google-code', state: 'opaque-state', oauthMode: 'disabled', signals: localSignals },
      {
        peekTransaction: vi.fn().mockResolvedValue({
          id: 'transaction-id',
          origin: localSignals.siteUrl,
          codeVerifier: 'pkce-verifier'
        }),
        consumeTransaction,
        exchangeCode,
        verifyPrincipal: vi.fn(),
        storeCredential,
        markNeedsReauth: vi.fn()
      }
    );

    expect(result).toEqual({ code: 'OAUTH_APPROVAL_REQUIRED' });
    expect(consumeTransaction).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it('consumes state once and sends the stored PKCE verifier to Google', async () => {
    const consumeTransaction = vi.fn().mockResolvedValue({
      id: 'transaction-id',
      teamId: '20000000-0000-4000-8000-000000000001',
      actorId: '10000000-0000-4000-8000-000000000001',
      origin: localSignals.siteUrl,
      codeVerifier: 'stored-pkce-verifier',
      credentialId: null
    });
    const exchangeCode = vi.fn().mockResolvedValue({
      accessToken: 'google-access-token-long-enough',
      refreshToken: 'google-refresh-token-long-enough'
    });
    const storeCredential = vi.fn().mockResolvedValue({ credentialId: 'credential-id' });

    const dependencies = {
      peekTransaction: vi.fn().mockResolvedValue({ origin: localSignals.siteUrl }),
      consumeTransaction,
      exchangeCode,
      verifyPrincipal: vi.fn().mockResolvedValue({
        permissionId: 'google-permission-id',
        email: 'owner@example.test'
      }),
      storeCredential,
      markNeedsReauth: vi.fn()
    };
    await expect(
      completeDriveOAuthCallback(
        { code: 'google-code', state: 'opaque-state', oauthMode: 'testing', signals: localSignals },
        dependencies
      )
    ).resolves.toEqual({ code: 'connected', credentialId: 'credential-id' });
    await expect(
      completeDriveOAuthCallback(
        { code: 'google-code', state: 'opaque-state', oauthMode: 'testing', signals: localSignals },
        { ...dependencies, consumeTransaction: vi.fn().mockResolvedValue(null) }
      )
    ).resolves.toEqual({ code: 'WRONG_STATE' });

    expect(exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'google-code', codeVerifier: 'stored-pkce-verifier' })
    );
  });

  it('preserves an existing refresh token when Google omits one', async () => {
    const storeCredential = vi.fn().mockResolvedValue({ credentialId: 'credential-id' });
    await completeDriveOAuthCallback(
      { code: 'google-code', state: 'opaque-state', oauthMode: 'verified', signals: localSignals },
      {
        peekTransaction: vi.fn().mockResolvedValue({ origin: localSignals.siteUrl }),
        consumeTransaction: vi.fn().mockResolvedValue({
          id: 'transaction-id',
          teamId: '20000000-0000-4000-8000-000000000001',
          actorId: '10000000-0000-4000-8000-000000000001',
          origin: localSignals.siteUrl,
          codeVerifier: 'stored-pkce-verifier',
          credentialId: 'credential-id'
        }),
        exchangeCode: vi.fn().mockResolvedValue({
          accessToken: 'google-access-token-long-enough',
          refreshToken: null
        }),
        verifyPrincipal: vi.fn().mockResolvedValue({
          permissionId: 'google-permission-id',
          email: 'owner@example.test'
        }),
        storeCredential,
        markNeedsReauth: vi.fn()
      }
    );

    expect(storeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: 'credential-id', refreshToken: undefined })
    );
  });

  it('maps invalid_grant to needs-reauth without exposing provider text', async () => {
    const credential: DriveCredential = {
      credentialId: 'credential-id',
      connectedBy: '10000000-0000-4000-8000-000000000001',
      googlePermissionId: 'google-permission-id',
      googleAccountEmail: 'owner@example.test',
      scope: 'https://www.googleapis.com/auth/drive',
      refreshToken: 'google-refresh-token-long-enough'
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'secret detail' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    );

    await expect(
      refreshGoogleAccessToken({
        credential,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        oauthMode: 'verified',
        productionSignals: localSignals,
        fetchImpl
      })
    ).rejects.toEqual(expect.objectContaining({ code: 'NEEDS_REAUTH', retryable: false }));
  });
});

describe('connection lifecycle and initial sync smoke path', () => {
  it('confirms a root, enqueues initial sync, exposes its first page, and checkpoints it', async () => {
    const persistConnection = vi.fn().mockResolvedValue({ connectionId: 'connection-id' });
    const enqueueInitialSync = vi.fn().mockResolvedValue({ jobId: 'job-id' });
    const result = await executeDriveConnectCommand(
      {
        action: 'confirm',
        teamId: '20000000-0000-4000-8000-000000000001',
        folderId: 'root-folder',
        expectedAccount: 'owner@example.test',
        confirmed: true
      },
      {
        oauthMode: 'testing',
        signals: localSignals,
        loadAccount: vi.fn().mockResolvedValue({ email: 'owner@example.test' }),
        getRoot: vi.fn().mockResolvedValue(driveFolder()),
        persistConnection,
        enqueueInitialSync
      }
    );
    expect(result).toMatchObject({ connectionId: 'connection-id', syncState: 'queued' });
    expect(persistConnection).toHaveBeenCalledBefore(enqueueInitialSync);

    const upsertPage = vi.fn();
    const checkpoint = vi.fn();
    await expect(
      runInitialSyncSlice(
        {
          jobId: 'job-id',
          connectionId: 'connection-id',
          rootFolderId: 'root-folder',
          folderQueue: ['root-folder'],
          pageToken: null
        },
        {
          listChildren: vi.fn().mockResolvedValue({
            files: [driveFolder({ id: 'visible-child', name: 'Visible child' })],
            nextPageToken: null
          }),
          upsertPage,
          checkpoint,
          enqueueChangeReplay: vi.fn()
        }
      )
    ).resolves.toMatchObject({ visible: 1, checkpointed: true });
    expect(upsertPage).toHaveBeenCalledWith(
      expect.objectContaining({ files: [expect.objectContaining({ id: 'visible-child' })] })
    );
    expect(checkpoint).toHaveBeenCalled();
  });

  it.each(['detach', 'replace'] as const)(
    '%s requires explicit confirmation and preserves Drive files',
    async action => {
      const mutateConnection = vi.fn().mockResolvedValue({ state: `${action}ed` });
      const deleteDriveFile = vi.fn();
      await expect(
        executeDriveConnectCommand(
          {
            action,
            teamId: '20000000-0000-4000-8000-000000000001',
            confirmed: true,
            idempotencyKey: `${action}-attempt-01`,
            ...(action === 'replace' ? { folderId: 'replacement-root' } : {})
          },
          {
            oauthMode: 'verified',
            signals: localSignals,
            mutateConnection,
            deleteDriveFile
          }
        )
      ).resolves.toBeTruthy();
      expect(mutateConnection).toHaveBeenCalledOnce();
      expect(deleteDriveFile).not.toHaveBeenCalled();
    }
  );
});

describe('typed Drive failures', () => {
  it('uses closed errors for invalid root responses', () => {
    expect(() => validateRootCandidate(driveFolder({ trashed: true }))).toThrowError(
      expect.any(TeamFunctionError)
    );
  });
});

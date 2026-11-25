// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — dialog fixtures keep the minimal client shape the other dialog tests use.
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type CatalogPublicationSnapshot
} from '@video-compressor/shared';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';

/**
 * 072 (П3, П6): a catalog never hangs in silence. A stopped publication says why and offers the
 * way on; creation refuses up front what the server would refuse; a creation nobody picked up
 * says why; codes that reached people as «something went wrong» have sentences.
 */

const { AuthContextOverride } = await import('../apps/web/src/auth/AuthContext');
const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
const { CatalogPublicationBlockedNote } =
  await import('../apps/web/src/team/product-catalog/CatalogPublicationBlockedNote');
const { CatalogCreatedPublicationStatus, forgetCatalogPublications } =
  await import('../apps/web/src/team/product-catalog/CatalogCreatedPublicationStatus');
const { CreateProductCatalogDialog } =
  await import('../apps/web/src/team/product-catalog/CreateProductCatalogDialog');
const { CatalogFixButton, catalogFixActionFor, catalogCodeMessage } =
  await import('../apps/web/src/team/catalogFixActions');
const { teamErrorMessage, teamErrorMessageFor } = await import('../apps/web/src/team/errors');
const { en } = await import('../apps/web/src/locales/en');

const TEAM_ID = '72000000-0000-4000-8000-000000000001';
const CATALOG = '72000000-0000-4000-8000-000000000002';
const JOB = '72000000-0000-4000-8000-000000000003';
const VIDEO = { id: '72000000-0000-4000-8000-000000000004', name: 'clip.mp4' };
const USER = 'catalog-user-072';

const team = (over: Partial<TeamContextSnapshot> = {}): TeamContextSnapshot => ({
  id: TEAM_ID,
  name: 'Creatives',
  role: 'owner',
  permissions: DEFAULT_ROLE_PERMISSIONS.owner,
  connectionState: 'connected',
  ...over
});

function wrap(children: React.ReactNode, snapshot: TeamContextSnapshot = team()) {
  return (
    <AuthContextOverride value={{ user: { id: USER } }}>
      <TeamProvider initialTeams={[snapshot]} realtime={false}>
        <ToastProvider>{children}</ToastProvider>
      </TeamProvider>
    </AuthContextOverride>
  );
}

const blocked = (
  reason: string,
  over: Partial<CatalogPublicationSnapshot> = {}
): CatalogPublicationSnapshot => ({
  catalogId: CATALOG,
  revision: 3,
  mode: 'immediate',
  dueAt: null,
  timeZone: null,
  target: { kind: 'source', materialId: VIDEO.id, sourceVersion: '1' },
  job: { id: JOB, state: 'blocked', revision: 3, writerFence: null, blockedReason: reason },
  active: null,
  serverNow: Date.now(),
  ...over
});

beforeEach(() => {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
  setPrivateCacheScope(USER, 'owner');
});
afterEach(() => {
  cleanup();
  forgetCatalogPublications();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('a stopped publication', () => {
  it('says Drive did not answer and puts the same job back in the queue', async () => {
    const retry = vi.fn().mockResolvedValue('requeued');
    const change = vi.fn();
    const onRetried = vi.fn();
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('target_unavailable')}
          onRetried={onRetried}
          client={{ retryCatalogPublication: retry, changeCatalogPublication: change }}
        />
      )
    );
    expect(screen.getByText(en.catalogPublicationBlockedTarget)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Publish again' }));
    expect(retry).toHaveBeenCalledWith(TEAM_ID, CATALOG, JOB);
    expect(change).not.toHaveBeenCalled();
    expect(onRetried).toHaveBeenCalledOnce();
    expect(await screen.findByText(en.catalogPublicationRetried)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull();
  });

  it('publishes a new revision when the writer had already touched the job', async () => {
    const retry = vi.fn().mockResolvedValue('republish');
    const change = vi.fn().mockResolvedValue(blocked('stale_job', { revision: 4 }));
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('stale_job')}
          onRetried={vi.fn()}
          client={{ retryCatalogPublication: retry, changeCatalogPublication: change }}
        />
      )
    );
    expect(screen.getByText(en.catalogPublicationBlockedStale)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Publish again' }));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({ catalogId: CATALOG, expectedRevision: 3, action: 'add_now' })
      )
    );
  });

  it('offers to reconnect Drive, not to publish into the same wall, when the space lost it', () => {
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('target_unavailable')}
          onRetried={vi.fn()}
          client={{ retryCatalogPublication: vi.fn() }}
        />,
        team({ connectionState: 'needs_reauth' })
      )
    );
    expect(screen.getByText(en.catalogPublicationBlockedDrive)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Drive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish again' })).toBeNull();
  });

  it('tells a member who cannot reconnect Drive whom to ask', () => {
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('target_unavailable')}
          onRetried={vi.fn()}
        />,
        team({
          connectionState: 'needs_reauth',
          role: 'editor',
          permissions: DEFAULT_ROLE_PERMISSIONS.editor
        })
      )
    );
    expect(screen.getByText(en.catalogFixAskOwner)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Reconnect Drive' })).toBeNull();
  });

  it('names a Drive refusal from the server and shows its door', async () => {
    const retry = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('NEEDS_REAUTH'), { code: 'NEEDS_REAUTH' }));
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('job_blocked')}
          onRetried={vi.fn()}
          client={{ retryCatalogPublication: retry }}
        />
      )
    );
    await userEvent.click(screen.getByRole('button', { name: 'Publish again' }));
    expect(await screen.findByText(en.catalogWaitNeedsReauth)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Drive' })).toBeTruthy();
  });

  it('says a retry and an unverified write are under way instead of saying nothing', () => {
    const { rerender } = render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('target_unavailable', {
            job: { id: JOB, state: 'retry_wait', revision: 3, writerFence: null }
          })}
          onRetried={vi.fn()}
        />
      )
    );
    expect(screen.getByText(en.catalogPublicationRetryWait)).toBeTruthy();
    rerender(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('target_unavailable', {
            job: { id: JOB, state: 'unknown', revision: 3, writerFence: JOB }
          })}
          onRetried={vi.fn()}
        />
      )
    );
    expect(screen.getByText(en.catalogPublicationVerifyingWrite)).toBeTruthy();
  });

  it('leaves legacy adoption to the dialog’s own verification', () => {
    const { container } = render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={TEAM_ID}
          catalogId={CATALOG}
          snapshot={blocked('legacy_adoption_required')}
          onRetried={vi.fn()}
        />
      )
    );
    expect(container.textContent).toBe('');
  });

  it('replaces the created catalog’s «publishing» line and stops polling a blocked job', async () => {
    const read = vi.fn().mockResolvedValue(blocked('target_unavailable'));
    render(
      wrap(<CatalogCreatedPublicationStatus teamId={TEAM_ID} catalogId={CATALOG} read={read} />)
    );
    expect(await screen.findByText(en.catalogPublicationBlockedTarget)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish again' })).toBeTruthy();
    expect(screen.queryByText(en.catalogPublicationPending)).toBeNull();
  });
});

describe('creating a catalog', () => {
  beforeEach(() => vi.stubEnv('VITE_APP_ENVIRONMENT', 'beta'));
  afterEach(() => vi.unstubAllEnvs());
  const preflight = (over = {}) =>
    vi.fn().mockResolvedValue({
      spaceAllowed: true,
      driveState: 'connected',
      canCreate: true,
      canRestitch: true,
      backgroundExecutor: true,
      ...over
    });
  const client = (over = {}) => ({
    getProductCatalogSettings: vi.fn().mockResolvedValue(null),
    createProductCatalog: vi.fn(),
    nextProductCatalogVariant: vi.fn().mockResolvedValue(1),
    ...over
  });
  const open = (c, snapshot?: TeamContextSnapshot) =>
    render(
      wrap(
        <CreateProductCatalogDialog teamId={TEAM_ID} video={VIDEO} client={c} onClose={vi.fn()} />,
        snapshot
      )
    );
  const fillLink = () =>
    userEvent.type(screen.getByLabelText(/^Link(?: · Required)?$/), 'https://offer.example.test/');

  it('refuses up front in a paused space, with the way to the tariff', async () => {
    const c = client({ catalogCreationPreflight: preflight({ spaceAllowed: false }) });
    open(c);
    expect(await screen.findByText(en.productCatalogPreflightSpaceBlocked)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the tariff' })).toBeTruthy();
    await fillLink();
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('refuses up front without Drive, instead of «the source changed» after Create', async () => {
    const c = client({ catalogCreationPreflight: preflight({ driveState: 'needs_reauth' }) });
    open(c);
    expect(await screen.findByText(en.productCatalogPreflightDrive)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Drive' })).toBeTruthy();
  });

  it('lets a ready space create as before', async () => {
    const c = client({ catalogCreationPreflight: preflight() });
    open(c);
    await waitFor(() => expect(c.catalogCreationPreflight).toHaveBeenCalledWith(TEAM_ID));
    await fillLink();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    );
    expect(screen.queryByText(en.productCatalogPreflightDrive)).toBeNull();
  });

  it('says why a creation’s videos have not started, with the door to fix it', async () => {
    const key = 'product-catalog:72000000-0000-4000-8000-000000000021';
    localStorage.setItem(`soty:catalog-video-create:v1:${USER}:${TEAM_ID}:${VIDEO.id}`, key);
    const c = client({
      createProductCatalogVideo: vi.fn(),
      readProductCatalogVideo: vi.fn().mockResolvedValue({
        outcome: 'preparing_video',
        catalogIntentId: '72000000-0000-4000-8000-000000000031',
        videoSetId: '72000000-0000-4000-8000-000000000032',
        requestedCount: 3,
        registeredCount: 0,
        state: 'preparing',
        waitReason: 'NEEDS_REAUTH'
      })
    });
    open(c);
    expect(await screen.findByText(en.catalogWaitNeedsReauth)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Drive' })).toBeTruthy();
  });
});

describe('codes that used to say «something went wrong»', () => {
  const t = (key: keyof typeof en) => en[key];
  it.each([
    'RESTITCH_DEFAULTS_INVALID',
    'CATALOG_VIDEO_PREPARING',
    'NOT_ELIGIBLE',
    'TRANSPORT_UNKNOWN',
    'DRIVE_FILE_MISSING',
    'CONNECTION_DETACHED',
    'LEASE_LOST_EXHAUSTED',
    'AGENT_STALLED',
    'DISK_FULL'
  ])('%s has its own sentence', code => {
    expect(teamErrorMessage(code, t)).not.toBe(en.teamErrorUnknown);
    expect(teamErrorMessageFor(new Error(code), t)).not.toBe(en.teamErrorUnknown);
  });
  it('a full disk and a full Google storage say what to free, and the storage has its door', () => {
    expect(teamErrorMessage('DISK_FULL', t)).toBe(en.teamErrorDiskFull);
    expect(teamErrorMessage('AGENT_STALLED', t)).toBe(en.catalogWaitAgentStalled);
    expect(catalogFixActionFor('DRIVE_STORAGE_FULL')).toBe('google_storage');
    expect(catalogFixActionFor('DISK_FULL')).toBeNull();
    render(wrap(<CatalogFixButton teamId={TEAM_ID} code="DRIVE_STORAGE_FULL" />));
    const link = screen.getByRole('link', { name: 'Free up space in Google Drive' });
    expect(link.getAttribute('href')).toBe('https://drive.google.com/settings/storage');
    expect(link.getAttribute('target')).toBe('_blank');
  });
  it('a passing failure offers the caller’s retry only when there is one', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      wrap(<CatalogFixButton teamId={TEAM_ID} code="DRIVE_UNAVAILABLE" />)
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(
      wrap(<CatalogFixButton teamId={TEAM_ID} code="DRIVE_UNAVAILABLE" onRetry={onRetry} />)
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it('a missing Drive folder is chosen again, not reconnected', () => {
    render(wrap(<CatalogFixButton teamId={TEAM_ID} code="ROOT_MISSING" />));
    expect(screen.getByRole('link', { name: 'Choose the Drive folder' })).toBeTruthy();
  });
  it('AGENT_ID_CONFLICT no longer talks about a file name', () => {
    expect(teamErrorMessage('AGENT_ID_CONFLICT', t)).toBe(en.teamErrorAgentIdConflict);
    expect(catalogCodeMessage('AGENT_ID_CONFLICT', t)).toBe(en.catalogWaitAgentIdConflict);
  });
  it('every code a catalog can stop on has one door', () => {
    expect(catalogFixActionFor('AGENT_REQUIRED')).toBe('connect_agent');
    expect(catalogFixActionFor('AGENT_STALLED')).toBe('repair_background');
    expect(catalogFixActionFor('NEEDS_REAUTH')).toBe('drive');
    expect(catalogFixActionFor('SPACE_BLOCKED')).toBe('tariffs');
    expect(catalogFixActionFor('AGENT_UPDATE_REQUIRED')).toBe('update_agent');
    expect(catalogFixActionFor('RESTITCH_INVALID')).toBe('restitch');
    expect(catalogFixActionFor('RATE_LIMITED')).toBe('retry');
    expect(catalogFixActionFor('RESTITCH_CLIENT_OUTDATED')).toBe('update_agent');
    expect(catalogFixActionFor('SOURCE_CHANGED')).toBe('open_catalog');
    expect(catalogFixActionFor('CONNECTION_DETACHED')).toBeNull();
    expect(catalogFixActionFor('PERMISSION_DENIED')).toBeNull();
    expect(catalogCodeMessage('SOMETHING_NEW', t)).toBe(en.teamErrorUnknown);
  });
});

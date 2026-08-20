import { useEffect, useState } from 'react';
import type {
  DriveCatalogResyncResult,
  DriveConnectionStatus,
  DriveFolderPage,
  DriveFolderSummary,
  DriveRootResult
} from '../../api/team';
import { TeamApiError } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';
import { DriveFolderBrowser } from './DriveFolderBrowser';
import { BetaStorageNotice, externalStorageUnavailableInBeta } from './BetaStorageNotice';

type SafeConnectionStatus = Partial<DriveConnectionStatus> & {
  state: DriveConnectionStatus['state'];
};

export interface DrivePanelClient {
  getConnectionStatus: (teamId: string) => Promise<SafeConnectionStatus>;
  startDriveOAuth?: (teamId: string) => Promise<{ authorizationUrl: string; expiresAt: string }>;
  listFolders: (
    teamId: string,
    parentId?: string,
    pageToken?: string | null
  ) => Promise<DriveFolderPage>;
  confirmDriveRoot: (input: {
    teamId: string;
    folderId: string;
    resourceKey?: string | null;
    expectedAccount?: string;
    confirmed: boolean;
  }) => Promise<DriveRootResult>;
  replaceDriveRoot?: (input: {
    teamId: string;
    folderId: string;
    resourceKey?: string | null;
    expectedAccount?: string;
  }) => Promise<DriveRootResult>;
  detachDrive?: (teamId: string, connectionId: string) => Promise<void>;
  resyncDrive?: (teamId: string) => Promise<DriveCatalogResyncResult>;
}

export function DriveConnectionPanel({
  teamId,
  client,
  revision = 0,
  onConnected
}: {
  teamId: string;
  client: DrivePanelClient;
  revision?: number;
  onConnected?: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SafeConnectionStatus>({ state: 'none' });
  const [folders, setFolders] = useState<DriveFolderPage | null>(null);
  const [selected, setSelected] = useState<DriveFolderSummary | null>(null);
  const [confirmation, setConfirmation] = useState<DriveRootResult | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [replaceMode, setReplaceMode] = useState(false);
  const [resyncQueued, setResyncQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .getConnectionStatus(teamId)
      .then(value => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError(t('teamDriveUnavailable'));
      });
    return () => {
      active = false;
    };
  }, [client, revision, t, teamId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const callbackCode = new URLSearchParams(window.location.search).get('drive');
    if (callbackCode === 'connected') void loadFolders();
    else if (callbackCode === 'OAUTH_APPROVAL_REQUIRED') setError(t('teamDriveApprovalRequired'));
    // The callback query is read once for this mounted team panel.
  }, [teamId]);

  const loadFolders = async (pageToken?: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const page = await client.listFolders(teamId, 'root', pageToken);
      setFolders(current =>
        current && pageToken
          ? { folders: [...current.folders, ...page.folders], nextPageToken: page.nextPageToken }
          : page
      );
    } catch (cause) {
      setError(
        cause instanceof TeamApiError && cause.code === 'OAUTH_APPROVAL_REQUIRED'
          ? t('teamDriveApprovalRequired')
          : t('teamDriveUnavailable')
      );
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!client.startDriveOAuth) {
      await loadFolders();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const started = await client.startDriveOAuth(teamId);
      setAuthorizationUrl(started.authorizationUrl);
    } catch (cause) {
      setError(
        cause instanceof TeamApiError && cause.code === 'OAUTH_APPROVAL_REQUIRED'
          ? t('teamDriveApprovalRequired')
          : t('teamDriveUnavailable')
      );
    } finally {
      setBusy(false);
    }
  };

  const choose = async (folder: DriveFolderSummary) => {
    setSelected(folder);
    if (replaceMode) {
      setConfirmation({
        state: 'confirmation_required',
        folder,
        account: status.connectedAccountEmail ?? '',
        independentAclWarning: true
      });
      return;
    }
    setBusy(true);
    try {
      setConfirmation(
        await client.confirmDriveRoot({
          teamId,
          folderId: folder.id,
          resourceKey: folder.resourceKey,
          confirmed: false
        })
      );
    } catch {
      setError(t('teamDriveUnavailable'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!selected || confirmation?.state !== 'confirmation_required') return;
    setBusy(true);
    try {
      const result =
        replaceMode && client.replaceDriveRoot
          ? await client.replaceDriveRoot({
              teamId,
              folderId: selected.id,
              resourceKey: selected.resourceKey,
              expectedAccount: confirmation.account
            })
          : await client.confirmDriveRoot({
              teamId,
              folderId: selected.id,
              resourceKey: selected.resourceKey,
              expectedAccount: confirmation.account,
              confirmed: true
            });
      setConfirmation(result);
      setStatus(current => ({
        ...current,
        state: 'connected',
        rootFolderName: selected.name
      }));
      setFolders(null);
      setReplaceMode(false);
      onConnected?.();
    } catch {
      setError(t('teamDriveUnavailable'));
    } finally {
      setBusy(false);
    }
  };

  const detach = async () => {
    if (!client.detachDrive || !status.connectionId) return;
    await client.detachDrive(teamId, status.connectionId);
    setStatus({ state: 'detached' });
    setConfirmation(null);
  };

  const resync = async () => {
    if (!client.resyncDrive || status.state !== 'connected') return;
    setBusy(true);
    setError(null);
    setResyncQueued(false);
    try {
      await client.resyncDrive(teamId);
      setStatus(current => ({
        ...current,
        state: 'connected',
        initialSyncState: 'scanning',
        lastErrorCode: null
      }));
      setResyncQueued(true);
      onConnected?.();
    } catch {
      setError(t('teamDriveResyncFailed'));
    } finally {
      setBusy(false);
    }
  };

  const connected = status.state === 'connected' || confirmation?.state === 'connected';
  return (
    <section className="team-panel team-drive-panel" aria-labelledby="team-drive-title">
      <div className="team-panel-heading">
        <h2 id="team-drive-title">{t('teamDriveTitle')}</h2>
        <span className={`team-connection-badge is-${status.state}`}>
          {connected
            ? t('teamDriveConnected')
            : status.state === 'needs_reauth'
              ? t('teamDriveNeedsReauth')
              : status.state === 'unavailable'
                ? t('teamDriveUnavailable')
                : t('teamDriveNotConnected')}
        </span>
      </div>
      {status.rootFolderName && <p>{status.rootFolderName}</p>}
      <BetaStorageNotice state={status.state} />
      {!connected && !folders && !externalStorageUnavailableInBeta(status.state) && (
        <Button type="button" variant="primary" loading={busy} onClick={() => void connect()}>
          {t('teamDriveConnect')}
        </Button>
      )}
      {authorizationUrl && (
        <a className="button button-primary" href={authorizationUrl} rel="noreferrer">
          {t('teamDriveAuthorize')}
        </a>
      )}
      {connected && (!folders || (status.state === 'connected' && client.resyncDrive)) && (
        <div className="team-inline-actions">
          {status.state === 'connected' && client.resyncDrive && (
            <Button type="button" variant="secondary" loading={busy} onClick={() => void resync()}>
              {t('teamDriveResync')}
            </Button>
          )}
          {!folders && client.replaceDriveRoot && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setReplaceMode(true);
                void loadFolders();
              }}
            >
              {t('teamDriveReplace')}
            </Button>
          )}
          {!folders && client.startDriveOAuth && (
            <Button type="button" variant="secondary" onClick={() => void connect()}>
              {t('teamDriveReauth')}
            </Button>
          )}
          {!folders && client.detachDrive && (
            <Button type="button" variant="danger" onClick={() => void detach()}>
              {t('teamDriveDetach')}
            </Button>
          )}
        </div>
      )}
      {folders && (
        <DriveFolderBrowser
          folders={folders.folders}
          nextPageToken={folders.nextPageToken}
          onChoose={folder => void choose(folder)}
          onLoadMore={() => void loadFolders(folders.nextPageToken)}
        />
      )}
      {confirmation?.state === 'confirmation_required' && (
        <div className="team-drive-confirmation">
          <strong>{confirmation.folder.name}</strong>
          <span>{confirmation.account}</span>
          <p>{t('teamDriveIndependentAcl')}</p>
          <Button type="button" variant="primary" loading={busy} onClick={() => void confirm()}>
            {t('teamDriveConfirmFolder')}
          </Button>
        </div>
      )}
      {confirmation?.state === 'connected' && <p>{t('teamSyncQueued')}</p>}
      {resyncQueued && <p role="status">{t('teamDriveResyncQueued')}</p>}
      {error && <p className="team-inline-error">{error}</p>}
    </section>
  );
}

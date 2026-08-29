import { useEffect, useId, useState } from 'react';
import type { TeamDriveSelection } from '@video-compressor/shared';
import type {
  DriveCatalogResyncResult,
  DriveConnectionStatus,
  DriveRootResult
} from '../../api/team';
import { TeamApiError } from '../../api/team';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { Modal } from '../../components/Modal';
import { teamErrorMessageFor } from '../errors';
import { Button } from '../../components/ui';
import { BetaStorageNotice, externalStorageUnavailableInBeta } from './BetaStorageNotice';
import { openFolderPicker, pickerConfig, type PickFolders } from '../storage/loadPicker';
import { SelectionList, selectionModeEnabled } from '../storage/SelectionList';

type SafeConnectionStatus = Partial<DriveConnectionStatus> & {
  state: DriveConnectionStatus['state'];
};

/**
 * What the settings panel and the create flow need from the client (011). The
 * folder is always picked in Google's own chooser; there is no server-side
 * browse any more because `drive.file` cannot list an account's folders.
 */
export interface DrivePanelClient {
  getConnectionStatus: (teamId: string) => Promise<SafeConnectionStatus>;
  startDriveOAuth?: (teamId: string) => Promise<{ authorizationUrl: string; expiresAt: string }>;
  pickerToken: (teamId: string) => Promise<{ accessToken: string; expiresAt: string }>;
  chooseRoot: (input: {
    teamId: string;
    folderId: string;
    resourceKey?: string | null;
    name?: string;
  }) => Promise<DriveRootResult>;
  replaceDriveRoot?: (input: {
    teamId: string;
    folderId: string;
    folderName?: string;
    resourceKey?: string | null;
    expectedAccount?: string;
  }) => Promise<DriveRootResult>;
  restoreRoot?: (teamId: string) => Promise<DriveRootResult>;
  detachDrive?: (teamId: string, connectionId: string) => Promise<void>;
  resyncDrive?: (teamId: string) => Promise<DriveCatalogResyncResult>;
  listDriveSelections?: (teamId: string) => Promise<TeamDriveSelection[]>;
  addDriveSelection?: (
    teamId: string,
    input: { driveFolderId: string; resourceKey: string | null; name: string }
  ) => Promise<TeamDriveSelection>;
  removeDriveSelection?: (teamId: string, selectionId: string) => Promise<void>;
  /** The chooser; tests inject one, production opens Google's. */
  pickFolders?: PickFolders;
}

export function DriveConnectionPanel({
  teamId,
  client,
  revision = 0,
  onConnected,
  config = pickerConfig()
}: {
  teamId: string;
  client: DrivePanelClient;
  revision?: number;
  onConnected?: () => void;
  config?: ReturnType<typeof pickerConfig>;
}) {
  const pickFolders = client.pickFolders ?? openFolderPicker;
  const { t } = useI18n();
  const { push } = useToasts();
  const [status, setStatus] = useState<SafeConnectionStatus>({ state: 'none' });
  const [authorized, setAuthorized] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [confirmingDetach, setConfirmingDetach] = useState(false);
  const detachTitleId = useId();
  const [resyncQueued, setResyncQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);

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
    if (callbackCode === 'connected') setAuthorized(true);
    else if (callbackCode === 'OAUTH_APPROVAL_REQUIRED') setError(t('teamDriveApprovalRequired'));
    // The callback query is read once for this mounted team panel.
  }, [teamId]);

  const explain = (cause: unknown) => {
    if (cause instanceof TeamApiError && cause.code === 'OAUTH_APPROVAL_REQUIRED') {
      return t('teamDriveApprovalRequired');
    }
    if (cause && typeof cause === 'object' && 'code' in cause) {
      if ((cause as { code: unknown }).code === 'PICKER_UNAVAILABLE') {
        return t('teamConnectPickerFailed');
      }
    }
    return teamErrorMessageFor(cause, t);
  };

  const connect = async () => {
    if (!client.startDriveOAuth) {
      setAuthorized(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const started = await client.startDriveOAuth(teamId);
      setAuthorizationUrl(started.authorizationUrl);
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * One chooser for both first connection and replacement. The chooser ran
   * with the credential the connection holds, so nothing is left to confirm.
   */
  const pick = async (mode: 'connect' | 'replace') => {
    if (!config && !client.pickFolders) {
      setError(t('teamConnectChooserUnavailable'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await client.pickerToken(teamId);
      const picked = await pickFolders({
        accessToken: token.accessToken,
        config,
        title: t('teamConnectChooserTitle')
      });
      const folder = picked?.[0];
      if (!folder) return;
      const result =
        mode === 'replace' && client.replaceDriveRoot
          ? await client.replaceDriveRoot({
              teamId,
              folderId: folder.id,
              folderName: folder.name,
              resourceKey: folder.resourceKey
            })
          : await client.chooseRoot({
              teamId,
              folderId: folder.id,
              resourceKey: folder.resourceKey,
              name: folder.name
            });
      if (result.state !== 'connected') {
        setError(t('teamDriveUnavailable'));
        return;
      }
      setStatus(current => ({
        ...current,
        state: 'connected',
        rootFolderName: result.folder.name,
        connectionId: result.connectionId ?? current.connectionId
      }));
      setSelectionRevision(value => value + 1);
      push({ tone: 'success', text: t('teamConnectPicked', { name: result.folder.name }) });
      onConnected?.();
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!client.restoreRoot) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.restoreRoot(teamId);
      if (result.state === 'connected') {
        setStatus(current => ({
          ...current,
          state: 'connected',
          rootFolderName: result.folder.name
        }));
        push({ tone: 'success', text: t('teamDriveRootRestored') });
        onConnected?.();
      }
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
    }
  };

  // Detaching used to be an unguarded await behind `void`: a failure left the
  // panel claiming the folder was still connected, with nothing said (S3).
  const detach = async () => {
    if (!client.detachDrive || !status.connectionId) return;
    try {
      await client.detachDrive(teamId, status.connectionId);
      setStatus({ state: 'detached' });
      setConfirmingDetach(false);
      push({ tone: 'success', text: t('teamToastDriveDetached') });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
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

  const connected = status.state === 'connected';
  const rootMissing = status.state === 'root_missing';
  const unavailable = externalStorageUnavailableInBeta(status.state);
  const badge = connected
    ? t('teamDriveConnected')
    : rootMissing
      ? t('teamDriveRootMissing')
      : status.state === 'needs_reauth'
        ? t('teamDriveNeedsReauth')
        : status.state === 'unavailable'
          ? t('teamDriveUnavailable')
          : t('teamDriveNotConnected');

  return (
    <section className="team-panel team-drive-panel" aria-labelledby="team-drive-title">
      <div className="team-panel-heading">
        <h2 id="team-drive-title">{t('teamDriveTitle')}</h2>
        <span className={`team-connection-badge is-${status.state}`}>{badge}</span>
      </div>
      {status.rootFolderName && <p>{status.rootFolderName}</p>}
      <BetaStorageNotice state={status.state} />

      {!connected && !rootMissing && !unavailable && !authorized && !authorizationUrl && (
        <Button type="button" variant="primary" loading={busy} onClick={() => void connect()}>
          {t('teamDriveConnect')}
        </Button>
      )}
      {!connected && !rootMissing && authorizationUrl && !authorized && (
        <a className="button button-primary" href={authorizationUrl} rel="noreferrer">
          {t('teamDriveAuthorize')}
        </a>
      )}
      {!connected && !rootMissing && !unavailable && authorized && (
        <Button type="button" variant="primary" loading={busy} onClick={() => void pick('connect')}>
          {t('teamConnectChooseFolder')}
        </Button>
      )}

      {rootMissing && (
        <div className="team-inline-actions">
          <p className="team-inline-error">{t('teamDriveRootMissingBody')}</p>
          {client.restoreRoot && (
            <Button type="button" variant="primary" loading={busy} onClick={() => void restore()}>
              {t('teamDriveRestoreRoot')}
            </Button>
          )}
          {client.replaceDriveRoot && (
            <Button
              type="button"
              variant="secondary"
              loading={busy}
              onClick={() => void pick('replace')}
            >
              {t('teamDriveChooseAnother')}
            </Button>
          )}
        </div>
      )}

      {connected && (
        <div className="team-inline-actions">
          {client.resyncDrive && (
            <Button type="button" variant="secondary" loading={busy} onClick={() => void resync()}>
              {t('teamDriveResync')}
            </Button>
          )}
          {client.replaceDriveRoot && (
            <Button
              type="button"
              variant="secondary"
              loading={busy}
              onClick={() => void pick('replace')}
            >
              {t('teamDriveReplace')}
            </Button>
          )}
          {/* A re-consent on a connected space (a wider scope, an expired
              grant) needs the same "continue in Google" step as a first
              connection; the button alone fetched the address and showed
              nothing, because the link lived in the not-connected branch. */}
          {client.startDriveOAuth && authorizationUrl && !authorized ? (
            <a className="button button-primary" href={authorizationUrl} rel="noreferrer">
              {t('teamDriveAuthorize')}
            </a>
          ) : (
            client.startDriveOAuth && (
              <Button
                type="button"
                variant="secondary"
                loading={busy}
                onClick={() => void connect()}
              >
                {t('teamDriveReauth')}
              </Button>
            )
          )}
          {client.detachDrive && (
            <Button type="button" variant="danger" onClick={() => setConfirmingDetach(true)}>
              {t('teamDriveDetach')}
            </Button>
          )}
        </div>
      )}

      {connected &&
        selectionModeEnabled() &&
        client.listDriveSelections &&
        client.addDriveSelection &&
        client.removeDriveSelection && (
          <SelectionList
            teamId={teamId}
            client={{
              listDriveSelections: client.listDriveSelections,
              addDriveSelection: client.addDriveSelection,
              removeDriveSelection: client.removeDriveSelection,
              pickerToken: client.pickerToken,
              pickFolders: client.pickFolders
            }}
            canManage
            revision={selectionRevision + revision}
            config={config}
          />
        )}

      {resyncQueued && <p role="status">{t('teamDriveResyncQueued')}</p>}
      {error && <p className="team-inline-error">{error}</p>}
      {confirmingDetach && (
        <Modal labelledBy={detachTitleId} size="sm" onClose={() => setConfirmingDetach(false)}>
          <h3 id={detachTitleId}>{t('teamDriveDetachConfirmTitle')}</h3>
          {/* States what everyone loses, and what is untouched. */}
          <p>{t('teamDriveDetachConfirmBody')}</p>
          <div className="team-dialog-actions">
            <Button type="button" variant="danger" onClick={() => void detach()}>
              {t('teamDriveDetach')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmingDetach(false)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

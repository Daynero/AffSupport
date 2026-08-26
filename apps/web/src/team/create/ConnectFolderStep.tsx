import { useEffect, useState } from 'react';
import type { DriveFolderPage, DriveFolderSummary, DriveRootResult } from '../../api/team';
import { TeamApiError } from '../../api/team';
import { Button } from '../../components/ui';
import { BetaStorageNotice, externalStorageUnavailableInBeta } from '../drive/BetaStorageNotice';
import { useI18n } from '../../i18n';
import { DriveFolderBrowser } from '../drive/DriveFolderBrowser';
import type { DrivePanelClient } from '../drive/DriveConnectionPanel';

/**
 * Wizard step 2: connect exactly one Google Drive folder as the space's shared
 * storage. Reuses the existing drive-connect sub-flow (start OAuth → browse →
 * two-phase confirm). Completion is gated on a `connected` root; production
 * OAuth gating (OAUTH_APPROVAL_REQUIRED) is surfaced and does not complete.
 */
export function ConnectFolderStep({
  teamId,
  client,
  onConnected,
  onBack,
  onCancel
}: {
  teamId: string;
  client: DrivePanelClient;
  onConnected: () => void;
  /** Return to the name step with what was typed still there. */
  onBack: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [folders, setFolders] = useState<DriveFolderPage | null>(null);
  const [selected, setSelected] = useState<DriveFolderSummary | null>(null);
  const [confirmation, setConfirmation] = useState<DriveRootResult | null>(null);
  const [trail, setTrail] = useState<DriveFolderSummary[]>([]);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const driveError = (cause: unknown) =>
    setError(
      cause instanceof TeamApiError && cause.code === 'OAUTH_APPROVAL_REQUIRED'
        ? t('teamDriveApprovalRequired')
        : t('teamDriveUnavailable')
    );

  const loadFolders = async (pageToken?: string | null, parentId = 'root') => {
    setBusy(true);
    setError(null);
    try {
      const page = await client.listFolders(teamId, parentId, pageToken);
      setFolders(current =>
        current && pageToken
          ? { folders: [...current.folders, ...page.folders], nextPageToken: page.nextPageToken }
          : page
      );
    } catch (cause) {
      driveError(cause);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const callback = new URLSearchParams(window.location.search).get('drive');
    if (callback === 'connected') void loadFolders();
    else if (callback === 'OAUTH_APPROVAL_REQUIRED') setError(t('teamDriveApprovalRequired'));
    // Read the OAuth callback once for this team's connect step.
  }, [teamId]);

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
      driveError(cause);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Steps into a folder, or back to the account root when given null. The
   * materials a team wants are usually nested, so browsing has to descend;
   * committing a root stays a separate, explicit act.
   */
  const openFolder = async (folder: DriveFolderSummary | null) => {
    if (!folder) {
      setTrail([]);
      setFolders(null);
      await loadFolders(null, 'root');
      return;
    }
    setTrail(current => {
      const seen = current.findIndex(entry => entry.id === folder.id);
      return seen >= 0 ? current.slice(0, seen + 1) : [...current, folder];
    });
    setFolders(null);
    await loadFolders(null, folder.id);
  };

  const choose = async (folder: DriveFolderSummary) => {
    setSelected(folder);
    setBusy(true);
    setError(null);
    try {
      setConfirmation(
        await client.confirmDriveRoot({
          teamId,
          folderId: folder.id,
          resourceKey: folder.resourceKey,
          confirmed: false
        })
      );
    } catch (cause) {
      driveError(cause);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!selected || confirmation?.state !== 'confirmation_required') return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.confirmDriveRoot({
        teamId,
        folderId: selected.id,
        resourceKey: selected.resourceKey,
        expectedAccount: confirmation.account,
        confirmed: true
      });
      if (result.state === 'connected') onConnected();
      else setConfirmation(result);
    } catch (cause) {
      driveError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="team-create-step" aria-labelledby="connect-folder-title">
      <div className="team-create-step-copy">
        <h2 id="connect-folder-title">{t('teamCreateStepFolderTitle')}</h2>
        <p>{t('teamCreateStepFolderHint')}</p>
        <BetaStorageNotice />
      </div>

      {/* The notice above already says this cannot work here, so offering the
          control anyway is the "silent element" FR-015 forbids — an enabled
          primary button directly under its own unavailability. The settings
          panel hides it through the same predicate; this step now agrees. */}
      {!folders && !authorizationUrl && !externalStorageUnavailableInBeta() && (
        <Button type="button" variant="primary" loading={busy} onClick={() => void connect()}>
          {t('teamDriveConnect')}
        </Button>
      )}

      {authorizationUrl && (
        <a className="button button-primary" href={authorizationUrl} rel="noreferrer">
          {t('teamDriveAuthorize')}
        </a>
      )}

      {folders && !confirmation && (
        <DriveFolderBrowser
          folders={folders.folders}
          nextPageToken={folders.nextPageToken}
          trail={trail}
          onOpen={folder => void openFolder(folder)}
          onChoose={folder => void choose(folder)}
          onLoadMore={() => void loadFolders(folders.nextPageToken, trail.at(-1)?.id ?? 'root')}
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
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setConfirmation(null);
              setSelected(null);
            }}
          >
            {t('teamFolderChooseAnother')}
          </Button>
        </div>
      )}

      {error && <p className="team-inline-error">{error}</p>}
      <p className="team-create-hint">{t('teamCreateFinishHint')}</p>
      <div className="team-create-actions">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('teamCreateBack')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('teamCancel')}
        </Button>
      </div>
    </section>
  );
}

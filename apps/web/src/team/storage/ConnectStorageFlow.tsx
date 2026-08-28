import { useEffect, useState } from 'react';
import { TeamApiError, type DriveRootResult } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { trackTeamStorageConnected } from '../../analytics/service';
import { BetaStorageNotice, externalStorageUnavailableInBeta } from '../drive/BetaStorageNotice';
import { openFolderPicker, pickerConfig, type PickFolders } from './loadPicker';

/**
 * Connect a space's storage in two inputs (011, FR-001): authorize Google once,
 * then pick the root in Google's own chooser. Nothing to confirm afterwards —
 * the chooser ran with the very credential the connection holds, so the space
 * opens the moment a folder is picked.
 */
export interface ConnectStorageClient {
  startDriveOAuth?: (teamId: string) => Promise<{ authorizationUrl: string; expiresAt: string }>;
  pickerToken: (teamId: string) => Promise<{ accessToken: string; expiresAt: string }>;
  chooseRoot: (input: {
    teamId: string;
    folderId: string;
    resourceKey?: string | null;
    name?: string;
  }) => Promise<DriveRootResult>;
  /** The chooser; tests inject one, production opens Google's. */
  pickFolders?: PickFolders;
}

export function ConnectStorageFlow({
  teamId,
  client,
  onConnected,
  onBack,
  onCancel,
  config = pickerConfig()
}: {
  teamId: string;
  client: ConnectStorageClient;
  onConnected: () => void;
  onBack?: () => void;
  onCancel: () => void;
  config?: ReturnType<typeof pickerConfig>;
}) {
  const pickFolders = client.pickFolders ?? openFolderPicker;
  const { t } = useI18n();
  const [authorized, setAuthorized] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const callback = new URLSearchParams(window.location.search).get('drive');
    if (callback === 'connected') setAuthorized(true);
    else if (callback === 'OAUTH_APPROVAL_REQUIRED') setError(t('teamDriveApprovalRequired'));
    // The OAuth callback is read once for this team's connect step.
  }, [teamId]);

  const explain = (cause: unknown) => {
    if (cause instanceof TeamApiError) {
      if (cause.code === 'OAUTH_APPROVAL_REQUIRED') return t('teamDriveApprovalRequired');
      if (cause.code === 'RESTRICTED_SCOPE_NOT_APPROVED') {
        return t('teamErrorRestrictedScopeNotApproved');
      }
      if (cause.code === 'NEEDS_REAUTH') return t('teamDriveNeedsReauth');
    }
    if (cause && typeof cause === 'object' && 'code' in cause) {
      if ((cause as { code: unknown }).code === 'PICKER_UNAVAILABLE') {
        return t('teamConnectPickerFailed');
      }
    }
    return t('teamDriveUnavailable');
  };

  const authorize = async () => {
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

  const choose = async () => {
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
      const result = await client.chooseRoot({
        teamId,
        folderId: folder.id,
        resourceKey: folder.resourceKey,
        name: folder.name
      });
      if (result.state === 'connected') {
        trackTeamStorageConnected({
          selectionCount: 1,
          storageKind: result.folder.driveKind
        });
        onConnected();
      } else {
        setError(t('teamDriveUnavailable'));
      }
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
    }
  };

  const unavailable = externalStorageUnavailableInBeta();

  return (
    <section
      className="team-create-step team-connect-storage"
      aria-labelledby="connect-folder-title"
    >
      <div className="team-create-step-copy">
        <h2 id="connect-folder-title">{t('teamCreateStepFolderTitle')}</h2>
        <p>{t('teamCreateStepFolderHint')}</p>
        {/* Said once, before the chooser, instead of as a step after it. */}
        <p className="team-connect-acl-note">{t('teamDriveIndependentAcl')}</p>
        <BetaStorageNotice />
      </div>

      {!unavailable && !authorized && !authorizationUrl && (
        <Button type="button" variant="primary" loading={busy} onClick={() => void authorize()}>
          {t('teamDriveConnect')}
        </Button>
      )}
      {!authorized && authorizationUrl && (
        <a className="button button-primary" href={authorizationUrl} rel="noreferrer">
          {t('teamDriveAuthorize')}
        </a>
      )}
      {!unavailable && authorized && (
        <Button type="button" variant="primary" loading={busy} onClick={() => void choose()}>
          {t('teamConnectChooseFolder')}
        </Button>
      )}

      {error && <p className="team-inline-error">{error}</p>}
      <p className="team-create-hint">{t('teamCreateFinishHint')}</p>
      <div className="team-create-actions">
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('teamCreateBack')}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('teamCancel')}
        </Button>
      </div>
    </section>
  );
}

import { useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { MemberList, type MemberManagementClient } from '../members/MemberList';
import { InvitationPanel, type InvitationPanelClient } from '../members/InvitationPanel';
import { TeamAuditPanel, type TeamAuditClient } from '../members/TeamAuditPanel';
import { DriveConnectionPanel, type DrivePanelClient } from '../drive/DriveConnectionPanel';

export interface SharePreferenceSettingsClient {
  resetLibrarySharePreference: (teamId: string) => Promise<boolean>;
}

export type SpaceSettingsClient = MemberManagementClient &
  InvitationPanelClient &
  TeamAuditClient &
  DrivePanelClient & {
    resetLibrarySharePreference: SharePreferenceSettingsClient['resetLibrarySharePreference'];
  };

export function SharePreferenceSettings({
  teamId,
  client
}: {
  teamId: string;
  client: SharePreferenceSettingsClient;
}) {
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  const [state, setState] = useState<'done' | 'empty' | 'failed' | null>(null);

  const reset = async () => {
    setResetting(true);
    setState(null);
    try {
      setState((await client.resetLibrarySharePreference(teamId)) ? 'done' : 'empty');
    } catch {
      setState('failed');
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="team-panel" aria-labelledby="creative-library-share-settings-title">
      <h2 id="creative-library-share-settings-title">{t('creativeLibraryShareSettingsTitle')}</h2>
      <p>{t('creativeLibraryShareSettingsDescription')}</p>
      <Button type="button" variant="secondary" loading={resetting} onClick={() => void reset()}>
        {t('creativeLibraryShareReset')}
      </Button>
      {state && (
        <p className={state === 'failed' ? 'team-inline-error' : undefined} role="status">
          {t(
            state === 'done'
              ? 'creativeLibraryShareResetDone'
              : state === 'empty'
                ? 'creativeLibraryShareResetEmpty'
                : 'creativeLibraryShareResetFailed'
          )}
        </p>
      )}
    </section>
  );
}

/**
 * Secondary management surface. Re-parents the existing 001 panels — members
 * (incl. role/permission and ownership controls via MemberList), invitations,
 * the Drive connection (owner), and audit (owner/admin) — each shown per its
 * existing permission gate. Kept off the default workspace so the primary view
 * stays content-first.
 */
export function SpaceSettings({
  teamId,
  client,
  directAddMode = 'disabled',
  onBack
}: {
  teamId: string;
  client: SpaceSettingsClient;
  directAddMode?: 'disabled' | 'testing';
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { activeTeam, can, notifyStateChanged, refreshTeams } = useTeam();
  const [revision, setRevision] = useState(0);
  const changed = () => {
    setRevision(value => value + 1);
    notifyStateChanged();
  };

  return (
    <section className="team-space-settings" aria-labelledby="team-space-settings-title">
      <header className="team-space-settings-header">
        <h2 id="team-space-settings-title">{t('teamSpaceSettings')}</h2>
        <Button type="button" variant="secondary" onClick={onBack}>
          {t('teamSpaceSettingsBack')}
        </Button>
      </header>

      <div className="team-space-settings-grid">
        <SharePreferenceSettings teamId={teamId} client={client} />
        <MemberList
          teamId={teamId}
          client={client}
          revision={revision}
          onChanged={() => {
            changed();
            void refreshTeams();
          }}
        />
        <InvitationPanel
          key={`invitations:${teamId}`}
          teamId={teamId}
          client={client}
          canManage={can('manage_members')}
          directAddMode={directAddMode}
          revision={revision}
          onChanged={changed}
        />
        {activeTeam?.role === 'owner' && (
          <DriveConnectionPanel
            key={`drive:${teamId}`}
            teamId={teamId}
            client={client}
            revision={revision}
            onConnected={changed}
          />
        )}
        {(activeTeam?.role === 'owner' || activeTeam?.role === 'admin') && (
          <TeamAuditPanel teamId={teamId} client={client} revision={revision} />
        )}
      </div>
    </section>
  );
}

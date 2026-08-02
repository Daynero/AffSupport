import { useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { MemberList, type MemberManagementClient } from '../members/MemberList';
import { InvitationPanel, type InvitationPanelClient } from '../members/InvitationPanel';
import { TeamAuditPanel, type TeamAuditClient } from '../members/TeamAuditPanel';
import { DriveConnectionPanel, type DrivePanelClient } from '../drive/DriveConnectionPanel';

export type SpaceSettingsClient = MemberManagementClient &
  InvitationPanelClient &
  TeamAuditClient &
  DrivePanelClient;

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

import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { InvitationPanel, type InvitationPanelClient } from '../members/InvitationPanel';
import { MemberList, type MemberManagementClient } from '../members/MemberList';

export type MembersSectionClient = MemberManagementClient & InvitationPanelClient;

/**
 * The Members destination (011, FR-029): who is in the space and who has been
 * asked. Storage, history and leaving live in the settings dialog.
 */
export function MembersSection({
  teamId,
  client,
  directAddMode = 'disabled'
}: {
  teamId: string;
  client: MembersSectionClient;
  directAddMode?: 'disabled' | 'testing';
}) {
  const { t } = useI18n();
  const { can, notifyStateChanged, refreshTeams } = useTeam();
  const [revision, setRevision] = useState(0);
  const changed = () => {
    setRevision(value => value + 1);
    notifyStateChanged();
  };
  return (
    <section
      className="team-space-settings team-members-section"
      aria-labelledby="team-members-title"
    >
      <h2 id="team-members-title">{t('teamSectionMembers')}</h2>
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
      </div>
    </section>
  );
}

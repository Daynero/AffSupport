import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { InvitationPanel, type InvitationPanelClient } from '../members/InvitationPanel';
import { MemberList, type MemberManagementClient } from '../members/MemberList';
import { LeaveSpacePanel, type LeaveSpaceClient } from '../members/LeaveSpacePanel';

export type MembersSectionClient = MemberManagementClient &
  InvitationPanelClient &
  LeaveSpaceClient;

/**
 * The Members destination (011, FR-029): who is in the space and who has been
 * asked — and how you stop being one of them, beside the ownership transfer
 * an owner needs first (024, FR-049). Storage and history live in the
 * settings dialog.
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
  const { activeTeam, can, notifyStateChanged, refreshTeams } = useTeam();
  const [revision, setRevision] = useState(0);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const changed = () => {
    setRevision(value => value + 1);
    notifyStateChanged();
  };
  return (
    <section
      className="team-space-settings team-members-section"
      aria-labelledby="team-members-title"
    >
      {/* Named for assistive technology only: the list's own title says
          "Members" one line below, and the tab above says it too (024, FR-096). */}
      <h2 id="team-members-title" className="visually-hidden">
        {t('teamSectionMembers')}
      </h2>
      <div className="team-space-settings-grid">
        <MemberList
          teamId={teamId}
          client={client}
          revision={revision}
          onLoaded={members => setMemberCount(members.length)}
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
      <LeaveSpacePanel
        teamId={teamId}
        client={client}
        isOwner={activeTeam?.role === 'owner'}
        alone={memberCount === 1}
      />
    </section>
  );
}

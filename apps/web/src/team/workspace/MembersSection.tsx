import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { InvitationPanel, type InvitationPanelClient } from '../members/InvitationPanel';
import { MemberList, type MemberManagementClient } from '../members/MemberList';
import { LeaveSpacePanel, type LeaveSpaceClient } from '../members/LeaveSpacePanel';
import { PermissionState } from '../../components/ui/index';

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
  const {
    activeTeam,
    can,
    notifyStateChanged,
    refreshTeams,
    revision: generalRevision,
    membersRevision
  } = useTeam();
  const revision = membersRevision ?? generalRevision;
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const isOwner = activeTeam?.role === 'owner';
  const changed = () => {
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
      {/* Two columns, as the owner shaped it: who is in the space on the left, the
          invitation card on the right. 070 stacked them full width, which turned a
          short list into a wide table with air between its columns and the form
          into a band under it. They stack again only where two do not fit. */}
      {can('manage_members') ? (
        <div className="team-space-settings-grid team-members-grid">
          <MemberList
            teamId={teamId}
            client={client}
            revision={revision}
            onLoaded={members => setMemberCount(members.length)}
            onChanged={() => {
              changed();
              void refreshTeams();
            }}
            footer={({ candidates, transferOwnership }) => (
              <LeaveSpacePanel
                teamId={teamId}
                client={client}
                isOwner={isOwner}
                alone={memberCount === 1}
                onTransferOwnership={candidates.length > 0 ? transferOwnership : undefined}
              />
            )}
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
      ) : (
        <div className="team-members-stack">
          <PermissionState message={t('teamMembersRestricted')} />
          <LeaveSpacePanel teamId={teamId} client={client} isOwner={isOwner} alone={false} />
        </div>
      )}
    </section>
  );
}

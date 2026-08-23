import { useId, useState } from 'react';
import { Button } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamResolverRoute } from '../routes';
import { teamErrorMessageFor } from '../errors';
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
    leaveTeam: (teamId: string) => Promise<{ ok: true; warningCode: string }>;
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
  const { activeTeam, can, notifyStateChanged, refreshTeams, replaceTeams, teams } = useTeam();
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
            onConnected={() => {
              changed();
              replaceTeams(
                teams.map(team =>
                  team.id === teamId ? { ...team, connectionState: 'connected' as const } : team
                )
              );
              void refreshTeams();
            }}
          />
        )}
        {(activeTeam?.role === 'owner' || activeTeam?.role === 'admin') && (
          <TeamAuditPanel teamId={teamId} client={client} revision={revision} />
        )}
        <LeaveSpacePanel teamId={teamId} client={client} isOwner={activeTeam?.role === 'owner'} />
      </div>
    </section>
  );
}

/**
 * Leaving a space, which until now had no way out at all short of asking an
 * admin to remove you (finding I2).
 *
 * The owner sees the reason rather than a disabled button: a space cannot be
 * left without an owner, and the way out is to transfer ownership first — which
 * is a thing they can actually do, one panel up.
 */
function LeaveSpacePanel({
  teamId,
  client,
  isOwner
}: {
  teamId: string;
  client: Pick<SpaceSettingsClient, 'leaveTeam'>;
  isOwner: boolean;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { setActiveTeamId, refreshTeams, replaceTeams, teams } = useTeam();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  const leave = async () => {
    setBusy(true);
    try {
      await client.leaveTeam(teamId);
      setConfirming(false);
      setActiveTeamId(null);
      // The space has to leave the list too, or the entry resolver would send
      // this person straight back into the space they just left. Dropped
      // locally first — the server has already told us the membership ended, so
      // waiting for a refetch would leave a window where the redirect wins.
      replaceTeams(teams.filter(team => team.id !== teamId));
      await refreshTeams();
      // The standing warning, said at the moment it becomes true: Google Drive
      // keeps its own sharing ACL, which leaving does not touch.
      push({ tone: 'info', text: t('teamLeaveDone'), sticky: true });
      navigateTo(teamResolverRoute(), true);
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="team-panel" aria-labelledby="team-leave-space-title">
      <h2 id="team-leave-space-title">{t('teamLeaveTitle')}</h2>
      {isOwner ? (
        <p>{t('teamLeaveOwnerExplanation')}</p>
      ) : (
        <>
          <p>{t('teamLeaveDescription')}</p>
          <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
            {t('teamLeaveAction')}
          </Button>
        </>
      )}
      {confirming && (
        <Modal labelledBy={titleId} size="sm" onClose={() => setConfirming(false)}>
          <h3 id={titleId}>{t('teamLeaveConfirmTitle')}</h3>
          {/* Names the consequence rather than asking "are you sure?" */}
          <p>{t('teamLeaveConfirmBody')}</p>
          <div className="team-dialog-actions">
            <Button type="button" variant="danger" loading={busy} onClick={() => void leave()}>
              {t('teamLeaveAction')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

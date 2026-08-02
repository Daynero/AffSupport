import { useEffect, useRef, useState } from 'react';
import type { TeamContextSnapshot } from '../api/team';
import { teamApi } from '../api/team';
import { Button } from '../components/ui';
import { useI18n } from '../i18n';
import { usePageEntrance } from '../lib/navigation';
import { configuredTeamDirectAddMode } from '../lib/config';
import { CreateTeamDialog } from './CreateTeamDialog';
import { TeamSwitcher } from './TeamSwitcher';
import { useTeam } from './TeamContext';
import { InvitationPanel, type InvitationPanelClient } from './members/InvitationPanel';
import { MemberList, type MemberManagementClient } from './members/MemberList';
import { TeamAuditPanel, type TeamAuditClient } from './members/TeamAuditPanel';
import { DriveConnectionPanel, type DrivePanelClient } from './drive/DriveConnectionPanel';
import { MaterialBrowser, type MaterialBrowserClient } from './catalog/MaterialBrowser';
import { TeamCatalog, type TeamCatalogClient } from './catalog/TeamCatalog';
import {
  completeTeamOnboardingFlow,
  startTeamOnboardingFlow,
  trackTeamWorkspaceSession,
  type TeamOnboardingFlow
} from '../analytics/service';

export type TeamWorkspaceClient = {
  listTeams: () => Promise<TeamContextSnapshot[]>;
  createTeam: (name: string) => Promise<TeamContextSnapshot>;
} & InvitationPanelClient &
  MemberManagementClient &
  TeamAuditClient &
  DrivePanelClient &
  MaterialBrowserClient &
  TeamCatalogClient;

export function TeamWorkspacePage({
  client = teamApi as TeamWorkspaceClient,
  directAddMode = configuredTeamDirectAddMode()
}: {
  client?: TeamWorkspaceClient;
  directAddMode?: 'disabled' | 'testing';
}) {
  const { t } = useI18n();
  const entering = usePageEntrance();
  const {
    teams,
    activeTeam,
    loading,
    error,
    revision,
    replaceTeams,
    setActiveTeamId,
    can,
    notifyStateChanged,
    refreshTeams
  } = useTeam();
  const [showCreate, setShowCreate] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const onboarding = useRef<{
    flow: TeamOnboardingFlow;
    invitePersisted: boolean;
    rootConfirmed: boolean;
  } | null>(null);
  const workspaceSessionTeam = useRef<string | null>(null);

  const ensureOnboarding = () => {
    onboarding.current ??= {
      flow: startTeamOnboardingFlow(),
      invitePersisted: false,
      rootConfirmed: false
    };
    return onboarding.current;
  };

  const markOnboarding = (part: 'invite' | 'root') => {
    const state = ensureOnboarding();
    if (part === 'invite') state.invitePersisted = true;
    else state.rootConfirmed = true;
    if (state.invitePersisted && state.rootConfirmed) {
      completeTeamOnboardingFlow(state.flow, {
        invitePersisted: true,
        rootConfirmed: true,
        syncQueued: true,
        outcome: 'success'
      });
    }
  };

  useEffect(() => {
    let active = true;
    void client
      .listTeams()
      .then(value => {
        if (active) {
          replaceTeams(value);
          setLocalError(null);
        }
      })
      .catch(() => {
        if (active) setLocalError(t('teamLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [client, replaceTeams, t]);

  useEffect(() => {
    if (!activeTeam || workspaceSessionTeam.current === activeTeam.id) return;
    workspaceSessionTeam.current = activeTeam.id;
    trackTeamWorkspaceSession();
  }, [activeTeam]);

  const createTeam = async (name: string) => {
    const created = await client.createTeam(name);
    replaceTeams([...teams.filter(team => team.id !== created.id), created]);
    setActiveTeamId(created.id);
    notifyStateChanged();
    return created;
  };

  const changed = () => {
    setLocalRevision(value => value + 1);
    notifyStateChanged();
  };

  const effectiveRevision = revision + localRevision;
  return (
    <main className={`page-container team-workspace-page ${entering ? 'page-enter' : ''}`.trim()}>
      <header className="team-workspace-header">
        <div>
          <p className="team-workspace-eyebrow">{t('teamWorkspace')}</p>
          {activeTeam && <h1>{activeTeam.name}</h1>}
        </div>
        <div className="team-workspace-header-actions">
          <TeamSwitcher />
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              ensureOnboarding();
              setShowCreate(true);
            }}
          >
            {t('teamCreate')}
          </Button>
        </div>
      </header>

      {(error || localError) && <p className="team-inline-error">{t('teamLoadFailed')}</p>}
      {loading && teams.length === 0 && <p aria-live="polite">…</p>}
      {!loading && teams.length === 0 && <p className="team-empty-state">{t('teamNoTeams')}</p>}

      {activeTeam && (
        <div className="team-workspace-grid">
          <div className="team-workspace-column">
            <MemberList
              teamId={activeTeam.id}
              client={client}
              revision={effectiveRevision}
              onChanged={() => {
                changed();
                void refreshTeams();
              }}
            />
            <InvitationPanel
              key={`invitations:${activeTeam.id}`}
              teamId={activeTeam.id}
              client={client}
              canManage={can('manage_members')}
              directAddMode={directAddMode}
              revision={effectiveRevision}
              onChanged={() => {
                markOnboarding('invite');
                changed();
              }}
            />
            {activeTeam.role === 'owner' && (
              <DriveConnectionPanel
                key={`drive:${activeTeam.id}`}
                teamId={activeTeam.id}
                client={client}
                revision={effectiveRevision}
                onConnected={() => {
                  markOnboarding('root');
                  changed();
                }}
              />
            )}
            {(activeTeam.role === 'owner' || activeTeam.role === 'admin') && (
              <TeamAuditPanel teamId={activeTeam.id} client={client} revision={effectiveRevision} />
            )}
          </div>
          <div className="team-workspace-column">
            <TeamCatalog key={`search:${activeTeam.id}`} teamId={activeTeam.id} client={client} />
            <MaterialBrowser
              key={`catalog:${activeTeam.id}`}
              teamId={activeTeam.id}
              client={client}
              revision={effectiveRevision}
              syncLabel={activeTeam.connectionState === 'connected' ? t('teamSyncFresh') : null}
            />
          </div>
        </div>
      )}

      {showCreate && (
        <CreateTeamDialog onClose={() => setShowCreate(false)} onCreate={createTeam} />
      )}
    </main>
  );
}

export default TeamWorkspacePage;

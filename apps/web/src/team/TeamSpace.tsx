import { useEffect, useId, useRef, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { Modal, ModalBackdrop } from '../components/Modal';
import { SupportDialog } from '../components/SupportDialog';
import { Button } from '../components/ui';
import { requireSupabaseClient } from '../lib/supabase';
import type { TeamContextSnapshot } from '../api/team';
import { teamApi } from '../api/team';
import { useI18n } from '../i18n';
import { navigateTo, usePageEntrance } from '../lib/navigation';
import { configuredTeamDirectAddMode } from '../lib/config';
import { useTeam } from './TeamContext';
import { SpaceLobby } from './lobby/SpaceLobby';
import { spaceReadiness } from './lobby/SpaceCard';
import { CreateSpaceWizard, type CreateSpaceWizardClient } from './create/CreateSpaceWizard';
import { WorkspaceShell, type WorkspaceShellClient } from './workspace/WorkspaceShell';

export type TeamSpaceClient = {
  listTeams: () => Promise<TeamContextSnapshot[]>;
} & CreateSpaceWizardClient &
  WorkspaceShellClient;

type Flow = { mode: 'browse' } | { mode: 'create' } | { mode: 'resume'; teamId: string };
type WorkspaceAccess = 'checking' | 'allowed' | 'denied';

/**
 * Single `/team` resolver. Renders exactly one surface — the space lobby, the
 * create wizard, or the workspace shell — based on the entered-space state in
 * TeamContext plus a local create/resume flow. A cached selection skips the
 * lobby; "Change space" returns to it.
 */
export function TeamSpace({
  client = teamApi as TeamSpaceClient,
  directAddMode = configuredTeamDirectAddMode()
}: {
  client?: TeamSpaceClient;
  directAddMode?: 'disabled' | 'testing';
}) {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const entering = usePageEntrance();
  const { teams, activeTeam, loading, replaceTeams, enterSpace, leaveSpace } = useTeam();
  const [flow, setFlow] = useState<Flow>({ mode: 'browse' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waitlistState, setWaitlistState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [gateOpen, setGateOpen] = useState(true);
  const [supportOpen, setSupportOpen] = useState(false);
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccess>(() => {
    // Component-only previews do not mount AuthProvider. Keep their existing
    // supplied-team behavior while the real application always asks the DB.
    if (!auth) return teams.length ? 'allowed' : 'denied';
    return auth.isAdmin ? 'allowed' : 'checking';
  });
  const gateTitleId = useId();
  const resumedFromDrive = useRef(false);

  // A Drive OAuth redirect returns to `/team?drive=...` and resets local flow.
  // Resume the mid-setup owned space back into the wizard's folder step so the
  // user does not have to re-find it in the lobby.
  useEffect(() => {
    if (resumedFromDrive.current || typeof window === 'undefined') return;
    const drive = new URLSearchParams(window.location.search).get('drive');
    if (!drive) return;
    const resumable = teams.find(team => team.role === 'owner' && spaceReadiness(team) !== 'ready');
    if (resumable) {
      resumedFromDrive.current = true;
      setFlow({ mode: 'resume', teamId: resumable.id });
    }
  }, [teams]);

  useEffect(() => {
    let active = true;
    void client
      .listTeams()
      .then(value => {
        if (!active) return;
        replaceTeams(value);
        setLoadError(null);
      })
      .catch(() => {
        if (active) setLoadError(t('teamSpaceLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [client, replaceTeams, t]);

  useEffect(() => {
    let active = true;
    if (!auth) {
      setWorkspaceAccess(teams.length ? 'allowed' : 'denied');
      return () => {
        active = false;
      };
    }
    if (auth.isAdmin) {
      setWorkspaceAccess('allowed');
      return () => {
        active = false;
      };
    }

    setWorkspaceAccess('checking');
    try {
      void requireSupabaseClient()
        .rpc('can_access_team_workspace')
        .then(
          ({ data, error }) => {
            if (active) setWorkspaceAccess(!error && data === true ? 'allowed' : 'denied');
          },
          () => {
            if (active) setWorkspaceAccess('denied');
          }
        );
    } catch {
      setWorkspaceAccess('denied');
    }
    return () => {
      active = false;
    };
  }, [auth, auth?.isAdmin, auth?.user?.id, teams.length]);

  const wrap = (node: React.ReactNode) => (
    <main className={`page-container team-space-page ${entering ? 'page-enter' : ''}`.trim()}>
      {node}
    </main>
  );

  const joinWaitlist = async () => {
    if (waitlistState === 'saving' || waitlistState === 'saved') return;
    setWaitlistState('saving');
    const { error } = await requireSupabaseClient().rpc('join_team_workspace_waitlist');
    setWaitlistState(error ? 'error' : 'saved');
  };

  const closeWorkspaceGate = () => {
    setGateOpen(false);
    navigateTo('/', true);
  };

  const openSupport = () => {
    setGateOpen(false);
    setSupportOpen(true);
  };

  const closeSupport = () => {
    setSupportOpen(false);
    navigateTo('/', true);
  };

  if (workspaceAccess === 'checking') {
    return wrap(
      <>
        <div className="team-workspace-gate-background" aria-busy="true" />
        <ModalBackdrop className="team-workspace-gate-backdrop" />
      </>
    );
  }

  if (workspaceAccess === 'denied') {
    return wrap(
      <>
        <div className="team-workspace-gate-background" aria-hidden="true" />
        {gateOpen && (
          <Modal
            labelledBy={gateTitleId}
            className="team-workspace-gate"
            backdropClassName="team-workspace-gate-backdrop"
            initialFocus="[data-team-waitlist]"
            onClose={closeWorkspaceGate}
          >
            <p className="team-workspace-eyebrow">{t('teamWorkspace')}</p>
            <h2 id={gateTitleId}>{t('teamWorkspaceGateTitle')}</h2>
            <p>{t('teamWorkspaceGateBody')}</p>
            <div className="team-workspace-gate-actions">
              <Button
                variant="primary"
                data-team-waitlist="true"
                loading={waitlistState === 'saving'}
                disabled={waitlistState === 'saved'}
                onClick={() => void joinWaitlist()}
              >
                {t(
                  waitlistState === 'saved' ? 'teamWorkspaceWaitlistSaved' : 'teamWorkspaceWaitlist'
                )}
              </Button>
              <Button onClick={openSupport}>{t('teamWorkspaceAccelerate')}</Button>
            </div>
            {waitlistState === 'error' && (
              <p className="support-error" role="alert">
                {t('teamWorkspaceWaitlistError')}
              </p>
            )}
          </Modal>
        )}
        {supportOpen && <SupportDialog onClose={closeSupport} />}
      </>
    );
  }

  if (flow.mode !== 'browse') {
    return wrap(
      <CreateSpaceWizard
        client={client}
        resumeTeamId={flow.mode === 'resume' ? flow.teamId : null}
        onCancel={() => setFlow({ mode: 'browse' })}
        onCreated={teamId => {
          enterSpace(teamId);
          setFlow({ mode: 'browse' });
        }}
      />
    );
  }

  if (activeTeam) {
    return wrap(
      <WorkspaceShell
        key={`shell:${activeTeam.id}`}
        teamId={activeTeam.id}
        client={client}
        directAddMode={directAddMode}
        onChangeSpace={leaveSpace}
      />
    );
  }

  return wrap(
    <SpaceLobby
      teams={teams}
      loading={loading}
      error={loadError}
      onEnter={enterSpace}
      onResume={teamId => setFlow({ mode: 'resume', teamId })}
      onCreate={() => setFlow({ mode: 'create' })}
    />
  );
}

export default TeamSpace;

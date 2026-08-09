import { useEffect, useId, useRef, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { Modal } from '../components/Modal';
import { SupportDialog } from '../components/SupportDialog';
import { Button } from '../components/ui';
import { requireSupabaseClient } from '../lib/supabase';
import type { TeamContextSnapshot } from '../api/team';
import { teamApi } from '../api/team';
import { useI18n } from '../i18n';
import { usePageEntrance } from '../lib/navigation';
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
  const isAdmin = useOptionalAuth()?.isAdmin === true;
  const entering = usePageEntrance();
  const { teams, activeTeam, loading, replaceTeams, enterSpace, leaveSpace } = useTeam();
  const [flow, setFlow] = useState<Flow>({ mode: 'browse' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waitlistState, setWaitlistState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [supportOpen, setSupportOpen] = useState(false);
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

  if (!loading && !isAdmin && teams.length === 0) {
    return wrap(
      <>
        <div className="team-workspace-gate-background" aria-hidden="true" />
        <Modal
          labelledBy={gateTitleId}
          className="team-workspace-gate"
          initialFocus="[data-team-waitlist]"
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
            <Button onClick={() => setSupportOpen(true)}>{t('teamWorkspaceAccelerate')}</Button>
          </div>
          {waitlistState === 'error' && (
            <p className="support-error" role="alert">
              {t('teamWorkspaceWaitlistError')}
            </p>
          )}
        </Modal>
        {supportOpen && <SupportDialog onClose={() => setSupportOpen(false)} />}
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

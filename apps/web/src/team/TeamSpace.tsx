import { useEffect, useRef, useState } from 'react';
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
  const entering = usePageEntrance();
  const { teams, activeTeam, loading, replaceTeams, enterSpace, leaveSpace } = useTeam();
  const [flow, setFlow] = useState<Flow>({ mode: 'browse' });
  const [loadError, setLoadError] = useState<string | null>(null);
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

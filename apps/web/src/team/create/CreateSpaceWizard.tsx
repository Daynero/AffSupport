import { useMemo, useRef, useState } from 'react';
import type { TeamContextSnapshot } from '../../api/team';
import { useI18n } from '../../i18n';
import {
  completeTeamOnboardingFlow,
  startTeamOnboardingFlow,
  type TeamOnboardingFlow
} from '../../analytics/service';
import { useTeam } from '../TeamContext';
import type { DrivePanelClient } from '../drive/DriveConnectionPanel';
import { SpaceNameStep } from './SpaceNameStep';
import { ConnectFolderStep } from './ConnectFolderStep';

export type CreateSpaceWizardClient = {
  createTeam: (name: string) => Promise<TeamContextSnapshot>;
} & DrivePanelClient;

type Step = { kind: 'name' } | { kind: 'folder'; teamId: string };

/**
 * Linear create-space flow: name (required) → connect folder (required) → done.
 * The team row is created when the name is committed (the folder step needs a
 * team id); an abandoned flow therefore leaves a resumable "setup-incomplete"
 * space, never a ready one. `resumeTeamId` re-enters directly at the folder
 * step for an already-created space.
 */
export function CreateSpaceWizard({
  client,
  resumeTeamId,
  onCancel,
  onCreated
}: {
  client: CreateSpaceWizardClient;
  resumeTeamId: string | null;
  onCancel: () => void;
  onCreated: (teamId: string) => void;
}) {
  const { t } = useI18n();
  const { teams, replaceTeams } = useTeam();
  const [step, setStep] = useState<Step>(
    resumeTeamId ? { kind: 'folder', teamId: resumeTeamId } : { kind: 'name' }
  );
  const onboarding = useRef<TeamOnboardingFlow>(startTeamOnboardingFlow());

  const stepNumber = step.kind === 'name' ? 1 : 2;
  const resumeName = useMemo(
    () => (resumeTeamId ? teams.find(team => team.id === resumeTeamId)?.name : undefined),
    [resumeTeamId, teams]
  );

  const handleCreated = (created: TeamContextSnapshot) => {
    replaceTeams([...teams.filter(team => team.id !== created.id), created]);
    setStep({ kind: 'folder', teamId: created.id });
  };

  const handleConnected = (teamId: string) => {
    replaceTeams(
      teams.map(team =>
        team.id === teamId ? { ...team, connectionState: 'connected' as const } : team
      )
    );
    completeTeamOnboardingFlow(onboarding.current, {
      invitePersisted: false,
      rootConfirmed: true,
      syncQueued: true,
      outcome: 'success'
    });
    onCreated(teamId);
  };

  return (
    <section className="team-create-wizard" aria-labelledby="team-create-title">
      <header className="team-create-wizard-header">
        <h1 id="team-create-title">{t('teamCreateSpaceTitle')}</h1>
        <p className="team-create-progress" aria-live="polite">
          {t('teamCreateStepProgress', { current: stepNumber, total: 2 })}
        </p>
      </header>

      {step.kind === 'name' ? (
        <SpaceNameStep
          createTeam={client.createTeam}
          onCreated={handleCreated}
          onCancel={onCancel}
        />
      ) : (
        <>
          {resumeName && <p className="team-create-resume-name">{resumeName}</p>}
          <ConnectFolderStep
            teamId={step.teamId}
            client={client}
            onConnected={() => handleConnected(step.teamId)}
            onBack={onCancel}
          />
        </>
      )}
    </section>
  );
}

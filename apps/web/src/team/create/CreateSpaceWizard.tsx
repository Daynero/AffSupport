import { useMemo, useRef, useState } from 'react';
import type { TeamContextSnapshot } from '../../api/team';
import { useI18n } from '../../i18n';
import { Progress } from '../../components/ui/index';
import {
  completeTeamOnboardingFlow,
  startTeamOnboardingFlow,
  type TeamOnboardingFlow
} from '../../analytics/service';
import { useTeam } from '../TeamContext';
import type { DrivePanelClient } from '../drive/DriveConnectionPanel';
import { SpaceNameStep } from './SpaceNameStep';
import { ConnectStorageFlow } from '../storage/ConnectStorageFlow';

export type CreateSpaceWizardClient = {
  createTeam: (name: string) => Promise<TeamContextSnapshot>;
  /**
   * Used only by the Back path: there is no rename RPC, so correcting the name
   * of an already-created draft means replacing the draft rather than leaving
   * an abandoned one behind. The server refuses this for anything that has ever
   * had a drive connection, which is exactly the case where replacing would be
   * destructive.
   */
  deleteDraftTeam: (teamId: string) => Promise<true>;
  /** Names a space after its folder when the suggested name was left as it was (024). */
  renameTeam?: (teamId: string, name: string) => Promise<string>;
} & DrivePanelClient;

/** The suggested name, in either language, with the number a second or third one gets. */
const SUGGESTED_NAME = /^(My space|Мій простір)( \d+)?$/u;

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
  // The draft this flow created, so Back can restore what was typed and a
  // corrected name can replace it instead of piling up abandoned spaces.
  const [draft, setDraft] = useState<TeamContextSnapshot | null>(null);

  const stepNumber = step.kind === 'name' ? 1 : 2;
  /*
   * A name to start from (024), so the first step can be a single press: "My space", or "My space
   * 2" beside one already called that. Left as it is, the space takes the chosen folder's name
   * once the folder is connected — which is what a person would have typed anyway.
   */
  const suggestedName = useMemo(() => {
    const base = t('teamCreateDefaultName');
    const taken = new Set(teams.map(team => team.name.trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let index = 2;
    while (taken.has(`${base} ${index}`.toLowerCase())) index += 1;
    return `${base} ${index}`;
  }, [t, teams]);
  const resumeName = useMemo(
    () => (resumeTeamId ? teams.find(team => team.id === resumeTeamId)?.name : undefined),
    [resumeTeamId, teams]
  );

  /**
   * Commit the name. An unchanged name on a second pass reuses the draft that
   * already exists — re-submitting it would otherwise collide with itself
   * (`create_team` refuses a duplicate name among your own spaces).
   */
  const submitName = async (name: string): Promise<TeamContextSnapshot> => {
    if (draft && draft.name === name) return draft;
    if (draft) {
      await client.deleteDraftTeam(draft.id);
      replaceTeams(teams.filter(team => team.id !== draft.id));
    }
    return client.createTeam(name);
  };

  const handleCreated = (created: TeamContextSnapshot) => {
    setDraft(created);
    replaceTeams([...teams.filter(team => team.id !== created.id), created]);
    setStep({ kind: 'folder', teamId: created.id });
  };

  const handleConnected = async (teamId: string) => {
    let name = teams.find(team => team.id === teamId)?.name ?? draft?.name ?? '';
    if (client.renameTeam && SUGGESTED_NAME.test(name.trim())) {
      try {
        const folder = (await client.getConnectionStatus(teamId)).rootFolderName?.trim();
        if (folder) name = await client.renameTeam(teamId, folder);
      } catch {
        // A folder name another space already has, or a slow read: the suggested name stays and
        // can be changed in the space's settings.
      }
    }
    replaceTeams(
      teams.map(team =>
        team.id === teamId ? { ...team, name, connectionState: 'connected' as const } : team
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
        {/* The line above already says which step this is; the bar is the same
            fact drawn, so it is not announced a second time. */}
        <Progress decorative value={(stepNumber / 2) * 100} size="xs" />
      </header>

      {step.kind === 'name' ? (
        <SpaceNameStep
          createTeam={submitName}
          onCreated={handleCreated}
          onCancel={onCancel}
          initialName={draft?.name ?? suggestedName}
        />
      ) : (
        <>
          {resumeName && <p className="team-create-resume-name">{resumeName}</p>}
          <ConnectStorageFlow
            teamId={step.teamId}
            client={client}
            onConnected={() => void handleConnected(step.teamId)}
            onBack={() => setStep({ kind: 'name' })}
            onCancel={onCancel}
          />
        </>
      )}
    </section>
  );
}

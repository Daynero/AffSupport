import type { TeamContextSnapshot } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { SpaceCard } from './SpaceCard';
import { InvitationList, type InvitationListClient } from './InvitationList';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';

/**
 * The space picker. Deliberately minimal: the user's teams as simple cards plus
 * one "Create a new space" action, or a welcoming empty state that leads
 * straight into creation. No management panels, audit, or filters appear here.
 */
export function SpaceLobby({
  teams,
  loading,
  error,
  onEnter,
  onResume,
  onCreate,
  onDeleteDraft,
  invitationClient
}: {
  teams: TeamContextSnapshot[];
  loading: boolean;
  error: string | null;
  onEnter: (teamId: string) => void;
  onResume: (teamId: string) => void;
  onCreate: () => void;
  /** Discards an abandoned, never-connected space (finding I3). */
  onDeleteDraft?: (space: TeamContextSnapshot) => void;
  /** Reads and answers invitations; falls back to the live API. */
  invitationClient?: InvitationListClient;
}) {
  const { t } = useI18n();

  if (loading && teams.length === 0) {
    return (
      <section className="team-space-lobby" aria-busy="true">
        <LabeledSkeleton label="teamSpaceLobbyLoading" rows={2} />
      </section>
    );
  }

  if (teams.length === 0) {
    return (
      <section
        className="team-space-lobby team-space-lobby-empty"
        aria-labelledby="team-lobby-title"
      >
        {/* Above the "create your first space" pitch: someone with a waiting
            invitation does not need to create anything. */}
        <InvitationList
          headingId="team-lobby-invitations"
          client={invitationClient}
          hideWhenEmpty
        />
        <div className="team-space-lobby-empty-copy">
          <h1 id="team-lobby-title">{t('teamSpaceEmptyTitle')}</h1>
          <p>{t('teamSpaceEmptyBody')}</p>
          <Button type="button" variant="primary" onClick={onCreate}>
            {t('teamSpaceEmptyAction')}
          </Button>
        </div>
        {error && <p className="team-inline-error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="team-space-lobby" aria-labelledby="team-lobby-title">
      <header className="team-space-lobby-header">
        <div>
          <h1 id="team-lobby-title">{t('teamSpaceLobbyTitle')}</h1>
          <p className="team-space-lobby-subtitle">{t('teamSpaceLobbySubtitle')}</p>
        </div>
        <Button type="button" variant="primary" onClick={onCreate}>
          {t('teamSpaceCreateNew')}
        </Button>
      </header>
      <InvitationList headingId="team-lobby-invitations" client={invitationClient} hideWhenEmpty />
      {error && <p className="team-inline-error">{error}</p>}
      <ul className="team-space-card-grid">
        {teams.map(space => (
          <li key={space.id}>
            <SpaceCard
              space={space}
              onEnter={onEnter}
              onResume={onResume}
              onDeleteDraft={onDeleteDraft}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

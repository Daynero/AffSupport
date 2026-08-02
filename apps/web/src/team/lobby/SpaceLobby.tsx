import type { TeamContextSnapshot } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { SpaceCard } from './SpaceCard';

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
  onCreate
}: {
  teams: TeamContextSnapshot[];
  loading: boolean;
  error: string | null;
  onEnter: (teamId: string) => void;
  onResume: (teamId: string) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();

  if (loading && teams.length === 0) {
    return (
      <section className="team-space-lobby" aria-busy="true">
        <p aria-live="polite">…</p>
      </section>
    );
  }

  if (teams.length === 0) {
    return (
      <section
        className="team-space-lobby team-space-lobby-empty"
        aria-labelledby="team-lobby-title"
      >
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
      {error && <p className="team-inline-error">{error}</p>}
      <ul className="team-space-card-grid">
        {teams.map(space => (
          <li key={space.id}>
            <SpaceCard space={space} onEnter={onEnter} onResume={onResume} />
          </li>
        ))}
      </ul>
    </section>
  );
}

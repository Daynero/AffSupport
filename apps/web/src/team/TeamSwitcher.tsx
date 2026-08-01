import { useI18n } from '../i18n';
import type { TeamContextSnapshot } from '../api/team';
import { useTeam } from './TeamContext';

function connectionLabel(
  state: TeamContextSnapshot['connectionState'],
  t: ReturnType<typeof useI18n>['t']
) {
  if (state === 'connected') return t('teamDriveConnected');
  if (state === 'needs_reauth') return t('teamDriveNeedsReauth');
  if (state === 'unavailable') return t('teamDriveUnavailable');
  return t('teamDriveNotConnected');
}

export function TeamSwitcher() {
  const { t } = useI18n();
  const { teams, activeTeamId, activeTeam, setActiveTeamId } = useTeam();
  if (teams.length === 0) return null;
  return (
    <div className="team-switcher">
      <label>
        <span>{t('teamActiveLabel')}</span>
        <select
          value={activeTeamId ?? ''}
          onChange={event => setActiveTeamId(event.target.value || null)}
        >
          {teams.map(team => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>
      {activeTeam && (
        <span className={`team-connection-badge is-${activeTeam.connectionState}`}>
          {connectionLabel(activeTeam.connectionState, t)}
        </span>
      )}
    </div>
  );
}

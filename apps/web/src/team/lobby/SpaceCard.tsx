import type { TeamContextSnapshot } from '../../api/team';
import { Card } from '../../components/Card';
import { useI18n } from '../../i18n';

export type SpaceReadiness = 'ready' | 'setup_incomplete' | 'preparing';

/**
 * Classify how a space should appear in the lobby from its shared connection
 * state and the viewer's role. A space is only enterable once its Drive root is
 * connected; an owner whose space never got a root sees "Continue setup", while
 * everyone else sees a read-only "being set up" state (covers an invited member
 * opening a space whose owner has not finished folder connection).
 */
export function spaceReadiness(space: TeamContextSnapshot): SpaceReadiness {
  if (space.connectionState === 'connected') return 'ready';
  if (
    space.role === 'owner' &&
    (space.connectionState === 'none' || space.connectionState === 'detached')
  ) {
    return 'setup_incomplete';
  }
  return 'preparing';
}

function roleLabel(role: TeamContextSnapshot['role'], t: ReturnType<typeof useI18n>['t']) {
  if (role === 'owner') return t('teamRoleOwner');
  if (role === 'admin') return t('teamRoleAdmin');
  if (role === 'editor') return t('teamRoleEditor');
  return t('teamRoleViewer');
}

export function SpaceCard({
  space,
  onEnter,
  onResume,
  onDeleteDraft
}: {
  space: TeamContextSnapshot;
  onEnter: (teamId: string) => void;
  onResume: (teamId: string) => void;
  /**
   * Offered only for an owner's never-finished space. The server has the final
   * say on whether it really is a draft, so this is an affordance, not a
   * guarantee.
   */
  onDeleteDraft?: (space: TeamContextSnapshot) => void;
}) {
  const { t } = useI18n();
  const readiness = spaceReadiness(space);
  const actionable = readiness !== 'preparing';
  const activate = () => {
    if (readiness === 'ready') onEnter(space.id);
    else if (readiness === 'setup_incomplete') onResume(space.id);
  };

  const actionLabel =
    readiness === 'ready'
      ? t('teamSpaceCardEnter')
      : readiness === 'setup_incomplete'
        ? t('teamSpaceCardContinueSetup')
        : t('teamSpaceCardPreparing');

  return (
    <Card
      as="article"
      interactive={actionable}
      className={`team-space-card is-${readiness}`}
      {...(actionable
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': `${space.name} — ${actionLabel}`,
            onClick: activate,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }
          }
        : { 'aria-label': `${space.name} — ${t('teamSpaceCardPreparingHint')}` })}
    >
      <div className="team-space-card-copy">
        <h3>{space.name}</h3>
        <p className="team-space-card-role">{roleLabel(space.role, t)}</p>
        {readiness === 'preparing' && (
          <p className="team-space-card-hint">{t('teamSpaceCardPreparingHint')}</p>
        )}
      </div>
      <span className={`team-space-card-action is-${readiness}`}>{actionLabel}</span>
      {readiness === 'setup_incomplete' && space.role === 'owner' && onDeleteDraft && (
        <button
          type="button"
          className="team-space-card-discard"
          // Stops the card's own activation: pressing "discard" must not also
          // resume the setup it is discarding.
          onClick={event => {
            event.stopPropagation();
            onDeleteDraft(space);
          }}
        >
          {t('teamDraftDeleteAction')}
        </button>
      )}
    </Card>
  );
}

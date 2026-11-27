import { useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { TeamContextSnapshot } from '../../api/team';
import { Card } from '../../components/Card';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { DropdownMenu, IconButton, type MenuEntry } from '../../components/ui/index';
import { useI18n } from '../../i18n';

export type SpaceReadiness = 'ready' | 'setup_incomplete' | 'preparing';

/**
 * Classify how a space should appear in the lobby from its shared connection
 * state and the viewer's role.
 *
 * An owner can enter any space whose folder was connected once, whatever state the
 * connection is in now: inside are the controls that fix it (reconnect, choose the folder
 * again). A space that never got a folder is "Continue setup". Only someone who cannot fix
 * anything sees "being set up" — a member of a space whose owner has not finished — and even
 * then the card's menu lets them leave (2026-11-25: an owner's space with an expired Google
 * sign-in used to say "being set up" to the owner, forever, with nothing to press).
 *
 * A connection that needs signing in again is browsable for everyone (011, FR-033): the catalog
 * indexed once stays readable, and the shell says what is wrong. A space on Soty storage (057)
 * never has a Drive connection and is ready as soon as it is created.
 */
export function spaceReadiness(space: TeamContextSnapshot): SpaceReadiness {
  // 057: an R2 space has no folder to connect; it is whole the moment it exists.
  if (space.storageBackend === 'r2') return 'ready';
  if (space.connectionState === 'connected' || space.connectionState === 'needs_reauth') {
    return 'ready';
  }
  if (space.role === 'owner') {
    return space.connectionState === 'none' || space.connectionState === 'detached'
      ? 'setup_incomplete'
      : 'ready';
  }
  return 'preparing';
}

function roleLabel(role: TeamContextSnapshot['role'], t: ReturnType<typeof useI18n>['t']) {
  if (role === 'owner') return t('teamRoleOwner');
  if (role === 'admin') return t('teamRoleAdmin');
  if (role === 'editor') return t('teamRoleEditor');
  return t('teamRoleViewer');
}

/** A state of the connection the owner has to act on, said on the card rather than hidden. */
function ownerAttention(space: TeamContextSnapshot): 'reconnect' | 'root' | 'pending' | null {
  if (space.role !== 'owner') return null;
  if (space.connectionState === 'root_missing') return 'root';
  if (space.connectionState === 'needs_reauth' || space.connectionState === 'unavailable') {
    return 'reconnect';
  }
  if (space.connectionState === 'pending') return 'pending';
  return null;
}

export function SpaceCard({
  space,
  onEnter,
  onResume,
  onRemove
}: {
  space: TeamContextSnapshot;
  onEnter: (teamId: string) => void;
  onResume: (teamId: string) => void;
  /**
   * The way out of the space: leaving for a member, deleting (or handing over first) for its
   * owner. The server has the final say; this only opens the dialog that asks it.
   */
  onRemove?: (space: TeamContextSnapshot) => void;
}) {
  const { t } = useI18n();
  const readiness = spaceReadiness(space);
  const attention = ownerAttention(space);
  const actionable = readiness !== 'preparing';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const activate = () => {
    if (readiness === 'ready') onEnter(space.id);
    else if (readiness === 'setup_incomplete') onResume(space.id);
  };

  const actionLabel =
    attention === 'root'
      ? t('teamDriveRootMissing')
      : attention === 'reconnect'
        ? t('spaceCardReconnect')
        : attention === 'pending'
          ? t('spaceCardFinishConnection')
          : readiness === 'ready'
            ? t('teamSpaceCardEnter')
            : readiness === 'setup_incomplete'
              ? t('teamSpaceCardContinueSetup')
              : t('teamSpaceCardPreparing');
  const hint =
    attention === 'root'
      ? t('teamSpaceRootMissingBody')
      : attention === 'reconnect'
        ? t('spaceCardReconnectHint')
        : attention === 'pending'
          ? t('spaceCardFinishConnectionHint')
          : readiness === 'preparing'
            ? t('teamSpaceCardPreparingHint')
            : null;

  const menu: MenuEntry[] = [
    ...(actionable
      ? [{ id: 'open', label: actionLabel, onSelect: activate }, 'separator' as const]
      : []),
    space.role === 'owner'
      ? {
          id: 'delete',
          label: t('spaceRemovalDeleteMenu'),
          destructive: true,
          onSelect: () => onRemove?.(space)
        }
      : {
          id: 'leave',
          label: t('spaceRemovalLeaveMenu'),
          destructive: true,
          onSelect: () => onRemove?.(space)
        }
  ];

  return (
    <div className="team-space-card-shell">
      <Card
        as="article"
        interactive={actionable}
        className={`team-space-card is-${readiness}${attention ? ' has-attention' : ''}`}
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
          : {
              'aria-label': `${space.name} — ${hint ?? actionLabel}`
            })}
      >
        <div className="team-space-card-copy">
          <h3>{space.name}</h3>
          <p className="team-space-card-role">{roleLabel(space.role, t)}</p>
          {hint && <p className="team-space-card-hint">{hint}</p>}
        </div>
        <span className={`team-space-card-action is-${attention ? 'setup_incomplete' : readiness}`}>
          {actionLabel}
        </span>
      </Card>
      {/* Beside the card, not inside it: the card is itself a button, and a button in a
          button is neither valid nor reachable as its own thing. */}
      {onRemove && (
        <>
          <IconButton
            ref={menuAnchor}
            className="team-space-card-menu"
            size="sm"
            label={t('spaceCardMenu')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(value => !value)}
          >
            <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <DropdownMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={menuAnchor}
            placement="bottom-end"
            minWidth={220}
            label={t('spaceCardMenu')}
            items={menu}
          />
        </>
      )}
    </div>
  );
}

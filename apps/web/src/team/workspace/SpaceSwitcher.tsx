import { useEffect, useId, useRef, useState } from 'react';
import type { TeamContextSnapshot } from '../../api/team';
import { useI18n } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute, teamResolverRoute } from '../routes';
import { spaceReadiness } from '../lobby/SpaceCard';
import { useTeam } from '../TeamContext';

/**
 * The space name, made into the way you change space.
 *
 * People look for "where am I" and "take me somewhere else" in the same place —
 * the title — which is why a separate "Change space" button was easy to miss.
 * The list is links, so every destination can be middle-clicked or copied.
 */
export function SpaceSwitcher({
  activeTeam,
  teams,
  headingId
}: {
  activeTeam: TeamContextSnapshot | null;
  teams: TeamContextSnapshot[];
  /** The shell's h1 id, so the trigger keeps labelling the page. */
  headingId: string;
}) {
  const { t } = useI18n();
  const { leaveSpace } = useTeam();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const others = teams.filter(team => team.id !== activeTeam?.id);
  // The menu always carries the way back to the lobby, so it always has
  // something to do — reading "nothing to switch to" as "nothing to offer" is
  // what left an owner of one space with no route to the lobby, and therefore
  // none to the create wizard that lives only there. FR-015 asks that a control
  // which cannot act be hidden; this one can.

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="team-space-switcher" ref={containerRef}>
      <h1 id={headingId} className="team-space-shell-title">
        <button
          type="button"
          className="team-space-switcher-trigger"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen(value => !value)}
        >
          <span>{activeTeam?.name ?? ''}</span>
          <span className="team-space-switcher-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </h1>
      {open && (
        <div className="team-space-switcher-menu" id={menuId}>
          {others.length > 0 && (
            <p className="team-space-switcher-label">{t('teamSpaceSwitcherOther')}</p>
          )}
          <ul>
            {others.map(space => {
              const href = buildTeamRoute({ spaceId: space.id });
              const ready = spaceReadiness(space) === 'ready';
              return (
                <li key={space.id}>
                  <a
                    href={href}
                    className="team-space-switcher-item"
                    onClick={event => {
                      setOpen(false);
                      internalLink(event, href);
                    }}
                  >
                    <span className="team-space-switcher-name">{space.name}</span>
                    {!ready && (
                      <span className="team-space-switcher-state">
                        {t('teamSpaceCardPreparing')}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
          {/* Leaving for the lobby also has to release the space in context —
              otherwise the realtime subscription outlives the view. A modified
              click opens a new tab instead, and this tab is left untouched,
              which is why the release is conditional on the in-app navigation
              actually having happened. */}
          <a
            href={teamResolverRoute({ showAll: true })}
            className="team-space-switcher-all"
            onClick={event => {
              setOpen(false);
              internalLink(event, teamResolverRoute({ showAll: true }));
              if (event.defaultPrevented) leaveSpace();
            }}
          >
            {t('teamSpaceSwitcherAll')}
          </a>
        </div>
      )}
    </div>
  );
}

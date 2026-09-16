/**
 * "There is nothing here yet" with the way to fix it attached.
 *
 * Every empty state in the space used to end in a sentence naming the place
 * that fills it — "create them in the space settings", "add them on the
 * Accounts tab" — and left the reader to go and find that place themselves,
 * from inside a dialog that first had to be closed. The sentence stays; under
 * it is now the door it describes, opening straight on the panel that fixes
 * the emptiness.
 */

import { useTeam } from './TeamContext';
import { buildTeamRoute, parseTeamRoute, type TeamSection, type TeamSettingsTab } from './routes';
import { currentRoute, navigateTo } from '../lib/navigation';
import { useI18n } from '../i18n';

/** Where a given emptiness is fixed: a settings tab, or another section. */
export type SpaceSettingsTarget =
  { kind: 'settings'; tab: TeamSettingsTab } | { kind: 'section'; section: TeamSection };

export function spaceRouteFor(teamId: string, target: SpaceSettingsTarget): string {
  if (target.kind === 'section')
    return buildTeamRoute({ spaceId: teamId, section: target.section });
  /*
   * Over wherever you are (024, FR-079). The settings used to be written onto
   * an explorer address, so a door in a task's catalog dialog closed the task,
   * threw you into Files, and left you there. The settings are the space's;
   * the address underneath — the open task, its section — stays, and closing
   * them puts you back inside what needed them.
   */
  const here = parseTeamRoute(currentRoute());
  const onThisSpace = here?.kind === 'space' && here.spaceId === teamId ? here : null;
  return buildTeamRoute({
    spaceId: teamId,
    section: onThisSpace?.section ?? 'explorer',
    query: { ...(onThisSpace?.query ?? {}), settings: true, settingsTab: target.tab }
  });
}

export function SpaceSettingsLink({
  target,
  label
}: {
  target: SpaceSettingsTarget;
  /** Says what will open, not "go to settings": the door is named by its room. */
  label?: string;
}) {
  const { t } = useI18n();
  const { activeTeam } = useTeam();
  // Without a space there is no address to send anyone to; the sentence above
  // this button still says what to do.
  if (!activeTeam) return null;
  const href = spaceRouteFor(activeTeam.id, target);
  return (
    <a
      className="team-empty-action"
      href={href}
      onClick={event => {
        // Left click stays in the app; modified clicks keep the browser's own
        // meaning (new tab, new window), which a bare button would swallow.
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateTo(href);
      }}
    >
      {label ?? t('teamSpaceSettings')}
    </a>
  );
}

import type { TeamContextSnapshot } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { FolderX } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { EmptyState, PermissionState, uiClasses } from '../../components/ui/index';

/**
 * The states worth explaining. `none` — a space whose folder was never
 * connected — reads to a member exactly like a space still being set up, so it
 * shares that copy rather than inventing a fifth thing to say.
 */
type Explained = 'detached' | 'needs_reauth' | 'unavailable' | 'pending' | 'root_missing';

/**
 * Says why a space has no files, when the reason is the storage connection.
 *
 * A member of a space whose Drive was disconnected used to see an empty file
 * tree and the ordinary "no materials here yet" line — indistinguishable from a
 * space nobody had put anything in (finding I4). Managers get the way to fix
 * it; everyone else gets told whom to ask, because a control they cannot use
 * would be worse than none.
 */
export function SpaceStatePanel({
  space,
  canManageDrive
}: {
  space: TeamContextSnapshot;
  /** Only the owner can reconnect storage (001). */
  canManageDrive: boolean;
}) {
  const { t } = useI18n();
  const state = space.connectionState;
  if (state === 'connected') return null;

  const copy: Record<Explained, { title: TranslationKey; body: TranslationKey }> = {
    detached: { title: 'teamSpaceDetachedTitle', body: 'teamSpaceDetachedBody' },
    needs_reauth: { title: 'teamSpaceReauthTitle', body: 'teamSpaceReauthBody' },
    unavailable: {
      title: 'teamSpaceStorageUnavailableTitle',
      body: 'teamSpaceStorageUnavailableBody'
    },
    pending: { title: 'teamSpacePendingTitle', body: 'teamSpacePendingBody' },
    // 011: the connected folder was deleted in the provider; nothing is lost.
    root_missing: { title: 'teamSpaceRootMissingTitle', body: 'teamSpaceRootMissingBody' }
  };
  const explained: Explained = state === 'none' ? 'pending' : state;
  const settingsRoute = buildTeamRoute({
    spaceId: space.id,
    section: 'explorer',
    query: { settings: true }
  });

  return (
    /* On the inventory (070, T030, 024 T135): the state is `EmptyState` — a heading, a
       sentence and the one door — instead of a hand-set panel with a hand-set button. */
    <section className="team-panel team-space-state" aria-labelledby="team-space-state-title">
      <EmptyState
        size="md"
        icon={<FolderX size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        titleAs="h2"
        title={<span id="team-space-state-title">{t(copy[explained].title)}</span>}
        description={t(copy[explained].body)}
        action={
          canManageDrive ? (
            /* A link, not a button: settings is an address like every other
               section, so it opens in a new tab the way people expect. */
            <a
              className={uiClasses('button', { color: 'primary', variant: 'solid', size: 'md' })}
              href={settingsRoute}
              onClick={event => internalLink(event, settingsRoute)}
            >
              {t('teamSpaceStateOpenSettings')}
            </a>
          ) : (
            <PermissionState
              className="team-space-state-hint"
              message={t('teamSpaceStateAskOwner')}
            />
          )
        }
      />
    </section>
  );
}

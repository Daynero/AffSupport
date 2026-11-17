import { BUILD_ID } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { siteChannel } from '../lib/config';
import { Badge } from './ui/index';

/**
 * Feature 051: the candidate address says what it is, on every screen, with the
 * build it is serving -- so "is this the new one?" after a rebuild has an answer
 * the tester can read rather than guess. Nothing is drawn on the main site.
 */
/** A quick next publication names itself: the app build next offers and the site's
 * own commit, instead of the release line's version it was built beside. */
const BUILD_LABEL = import.meta.env.VITE_NEXT_BUILD_LABEL?.trim() || BUILD_ID;

export function NextChannelBadge({ origin }: { origin?: string | null }) {
  const { t } = useI18n();
  if (siteChannel(origin) !== 'next') return null;
  return (
    <div className="next-channel-badge" role="status">
      <Badge color="warning" variant="solid" size="sm" title={t('nextChannelHint')}>
        {t('nextChannelBadge', { build: BUILD_LABEL })}
      </Badge>
    </div>
  );
}

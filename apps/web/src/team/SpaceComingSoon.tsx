import { useEffect } from 'react';
import { LockKeyhole } from 'lucide-react';
import { analytics } from '../analytics/service';
import { Empty } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';

/** Closed public entry until the announcement. Membership is checked by TeamSpace. */
export function SpaceComingSoon() {
  const { t } = useI18n();
  useEffect(() => {
    analytics.track('screen_viewed', { screen_identifier: 'space_coming_soon' });
  }, []);
  return (
    <section className="team-space-lobby team-space-lobby-empty team-space-no-access">
      <Empty
        className="team-space-no-access-card"
        size="lg"
        icon={<LockKeyhole size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        titleAs="h2"
        title={t('spaceComingSoonTitle')}
        description={t('spaceComingSoonBody')}
      />
    </section>
  );
}

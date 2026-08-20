import { configuredEnvironment } from '../lib/config';
import { useI18n } from '../i18n';

/**
 * Persistent beta indicator.
 *
 * A copy that behaves exactly like production and *looks* exactly like it is a
 * footgun: sooner or later someone debugs beta believing it is production, or
 * the reverse. The badge is therefore always on screen in a beta build — no
 * scrolling, no menu — and renders nothing at all in production, so it costs
 * the shipped app one boolean check.
 */
export function EnvironmentBadge() {
  const { t } = useI18n();
  if (configuredEnvironment() !== 'beta') return null;
  return (
    <div className="environment-badge" role="note" title={t('betaBadgeTitle')}>
      {t('betaBadge')}
    </div>
  );
}

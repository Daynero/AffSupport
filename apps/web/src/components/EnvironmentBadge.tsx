import { builtForEnvironment } from '../lib/config';
import { Badge } from './ui/index';
import { useI18n } from '../i18n';

/**
 * Persistent beta indicator.
 *
 * A copy that behaves exactly like production and *looks* exactly like it is a
 * footgun: sooner or later someone debugs beta believing it is production, or
 * the reverse. The badge is therefore always on screen in a beta build — no
 * scrolling, no menu — and renders nothing at all in production, so it costs
 * the shipped app one boolean check.
 *
 * It reads the build's own environment value rather than the validated config:
 * a beta profile with a mistake in it still has to look like beta, and that is
 * precisely the build someone is most likely to mistake for production.
 */
export function EnvironmentBadge() {
  const { t } = useI18n();
  if (builtForEnvironment() !== 'beta') return null;
  return (
    /* The inventory's badge with the warning role: a build that is not
       production says so in the colour the product uses for "look at this". */
    <Badge
      className="environment-badge"
      color="warning"
      variant="solid"
      size="sm"
      role="note"
      title={t('betaBadgeTitle')}
    >
      {t('betaBadge')}
    </Badge>
  );
}

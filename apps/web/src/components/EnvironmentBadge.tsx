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
 *
 * Where there is a top bar it stands in it, beside the mark (070, T077): the
 * floating copy sat bottom-left over the content on every screen narrower than
 * a desktop, and on a phone it covered a row of files. Screens with no bar
 * (sign-in, legal) keep the floating one; a stylesheet rule hides it as soon
 * as a bar carries its own.
 */
export function EnvironmentBadge({ placement = 'floating' }: { placement?: 'floating' | 'bar' }) {
  const { t } = useI18n();
  if (builtForEnvironment() !== 'beta') return null;
  return (
    /* The inventory's badge with the warning role: a build that is not
       production says so in the colour the product uses for "look at this". */
    <Badge
      className={`environment-badge is-${placement}`}
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

import { useState } from 'react';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { retryBackgroundRecovery } from '../../api/recovery';
import { spaceRouteFor } from '../SpaceSettingsLink';

/**
 * A manager round that this computer's background work has not picked up.
 *
 * 1.4.3: the row read «Очікуємо підготовку відео…» for as long as the agent's
 * background worker stayed parked, which nothing told the person about. The
 * row now says so where the round is shown, with the one action that
 * restarts it; when this computer cannot do that (agent offline, another
 * computer's work), the way to the setting is offered instead.
 */
export function CatalogBackgroundStalledNote({
  teamId,
  onRetried
}: {
  teamId: string;
  onRetried?: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  return (
    <span className="catalog-background-stalled">
      {t(state === 'done' ? 'catalogBackgroundStalledRetried' : 'catalogBackgroundStalled')}
      {state !== 'done' && (
        <Button
          variant="ghost"
          size="sm"
          loading={state === 'busy'}
          onClick={() => {
            setState('busy');
            void retryBackgroundRecovery(teamId)
              .then(() => {
                setState('done');
                onRetried?.();
              })
              .catch(() => setState('failed'));
          }}
        >
          {t('catalogBackgroundStalledRetry')}
        </Button>
      )}
      {state === 'failed' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'general' }))}
        >
          {t('catalogBackgroundStalledSettings')}
        </Button>
      )}
    </span>
  );
}

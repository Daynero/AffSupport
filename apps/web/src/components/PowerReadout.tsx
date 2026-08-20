import { useI18n } from '../i18n';
import { usePower } from '../lib/power';

/**
 * What Soty is consuming right now, in words.
 *
 * The one rule that matters here: a percentage is rendered only from an `ok`
 * sample. "Unavailable" and "0%" are different claims, and showing the second
 * when the first is true would quietly mislead — the user would read a stalled
 * agent as an idle one.
 */
export function PowerReadout() {
  const { t } = useI18n();
  const { state, status } = usePower();

  return (
    <p className="power-readout" aria-live="polite">
      {text()}
    </p>
  );

  function text(): string {
    if (status === 'offline') return t('powerAgentOffline');
    if (status === 'unsupported') return t('powerAgentOutdated');
    if (status === 'error') return t('powerUsageUnavailable');
    if (!state) return t('powerUsageMeasuring');

    if (state.sample.availability !== 'ok') {
      // No figure exists yet, or the platform cannot produce one. Say so.
      return state.sample.availability === 'warming-up'
        ? t('powerUsageMeasuring')
        : t('powerUsageUnavailable');
    }

    const percent = state.sample.systemSharePercent.toFixed(1);
    return state.sample.activity === 'active'
      ? t('powerUsageActive', { percent })
      : t('powerUsageIdle', { percent });
  }
}

/**
 * Shown when the host cannot hold already-running work to the limit, so the
 * user is never told a ceiling is in force when it only applies to work started
 * from now on.
 */
export function PowerThrottleNotice() {
  const { t } = useI18n();
  const { state, status } = usePower();
  if (status !== 'ready' || !state || state.throttlingSupported) return null;
  return <p className="power-notice">{t('powerThrottleUnsupported')}</p>;
}

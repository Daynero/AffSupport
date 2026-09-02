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
/** Below this the graphics are effectively idle and the extra number is only noise. */
const GRAPHICS_WORTH_SAYING = 5;

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
    const graphics = state.sample.graphicsSharePercent;
    const parts = [
      state.sample.activity === 'active'
        ? t('powerUsageActive', { percent })
        : t('powerUsageIdle', { percent })
    ];
    /*
     * Whether the lever is doing anything, said outright.
     *
     * Speech recognition runs on the graphics processor and uses almost no CPU, so moving the
     * lever changed no number on this panel — and the reasonable conclusion was that the
     * setting did nothing. It does: work is stopped and started to hold the share. That is a
     * fact about Soty's own behaviour, which is what the lever promises, so it is stated
     * rather than left to be inferred from a percentage that cannot show it.
     */
    if (state.holdingToLimit) {
      parts.push(t('powerUsageHolding', { limit: String(state.limitPercent) }));
    }
    /*
     * And the graphics, named as the computer's.
     *
     * macOS publishes no per-process graphics usage without elevated privileges, so this is
     * the whole device — a browser or a video call is in it too. Shown because a processor
     * share of 0.3% during a transcription that has the machine on its knees is a truth that
     * misleads on its own; labelled carefully because claiming it as Soty's would be a
     * different untruth.
     */
    if (graphics !== null && graphics >= GRAPHICS_WORTH_SAYING) {
      parts.push(t('powerUsageGraphics', { graphics: String(graphics) }));
    }
    return parts.join(' · ');
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

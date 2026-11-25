/**
 * "Re-stitched videos in seconds" — the space's preparation as a feature, not a footnote (071).
 *
 * It was a grey paragraph of three lines and a button nobody had pressed, and once pressed it sat
 * on "1 of 256" for minutes. What it does is worth showing: a space whose videos were read once
 * re-stitches each of them in seconds, for everyone. So the card leads with that, keeps the one
 * number that matters on screen in every state — how many of the space's videos are ready — and,
 * while it works, names the video in hand, how long it has been on it and roughly how long is
 * left, so a long video reads as work rather than as a hang.
 *
 * Pause is the old stop: everything finished is stored as it lands, and the next run skips it,
 * so "continue" picks up at the next video rather than at the first.
 */

import { useEffect, useState } from 'react';
import { CircleCheck, Clock, Zap } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { Alert, Button, Progress } from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { teamErrorMessageFor } from '../../errors';
import type { RestitchPreparationState } from '../../restitch/useRestitchPreparation';
import type { RestitchReadiness } from './useRestitchReadiness';

const MINUTE = 60_000;

function busy(phase: RestitchPreparationState['phase']): boolean {
  return phase === 'folder' || phase === 'listing' || phase === 'running';
}

/** A clock that ticks only while something is moving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function RestitchPrepareCard({
  state,
  readiness,
  connected,
  driveConnected,
  off,
  onStart,
  onPause
}: {
  state: RestitchPreparationState;
  readiness: RestitchReadiness | null;
  /** The Soty app is running on this computer; it does the reading. */
  connected: boolean;
  driveConnected: boolean;
  /** Both screens off: there is nothing to prepare for. */
  off: boolean;
  onStart: () => void;
  onPause: () => void;
}) {
  const { t, language } = useI18n();
  const working = busy(state.phase);
  const now = useNow(working);

  // The run's own count while it runs or has just run; the space's otherwise.
  const fromRun = state.phase !== 'idle' && state.total > 0;
  const total = fromRun ? state.total : (readiness?.total ?? 0);
  const ready = fromRun ? state.ready : (readiness?.ready ?? 0);
  const done = fromRun ? state.done : ready;
  const known = fromRun || readiness !== null;
  const remaining = Math.max(0, total - done);
  const complete = known && total > 0 && remaining === 0 && !working;

  const fraction =
    total > 0
      ? Math.min(1, (done + (working ? Math.min(0.95, state.mediaProgress ?? 0) : 0)) / total)
      : 0;

  // The pace of this run's finished videos is the only honest base for an estimate.
  const finishedThisRun = fromRun ? state.done - (state.already ?? 0) : 0;
  const eta =
    working && state.startedAt && finishedThisRun > 0 && remaining > 0
      ? ((now - state.startedAt) / finishedThisRun) * remaining
      : null;
  const onCurrent = state.current ? now - state.current.since : 0;

  const date = readiness?.lastPreparedAt
    ? new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
        day: 'numeric',
        month: 'short'
      }).format(new Date(readiness.lastPreparedAt))
    : null;

  const blocked = !driveConnected || off;
  const status = (() => {
    if (!driveConnected) return t('teamRestitchPrepareNoDrive');
    if (off) return t('teamRestitchPrepareNeedsDefaults');
    if (state.phase === 'folder' || state.phase === 'listing')
      return t('teamRestitchBoostCounting');
    if (state.phase === 'running') {
      const parts: string[] = [];
      if (state.current)
        parts.push(
          state.mediaPhase === 'converting' || state.mediaPhase === 'verifying'
            ? t('teamRestitchBoostConverting', {
                name: state.current.name,
                progress: Math.round((state.mediaProgress ?? 0) * 100)
              })
            : t('teamRestitchBoostReading', { name: state.current.name })
        );
      if (onCurrent >= MINUTE)
        parts.push(t('teamRestitchBoostOnFile', { minutes: Math.floor(onCurrent / MINUTE) }));
      if (eta !== null)
        parts.push(t('teamRestitchBoostEta', { minutes: Math.max(1, Math.round(eta / MINUTE)) }));
      return parts.join(' · ');
    }
    if (state.phase === 'failed')
      return teamErrorMessageFor(new Error(state.errorCode ?? 'PREPARE_FAILED'), t);
    if (state.phase === 'canceled') return t('teamRestitchBoostPaused');
    if (known && total === 0) return t('teamRestitchBoostEmpty');
    return '';
  })();

  const action = (() => {
    if (blocked) return null;
    if (working)
      return (
        <Button type="button" variant="secondary" onClick={onPause}>
          {t('teamRestitchBoostPause')}
        </Button>
      );
    if (complete || (known && total === 0)) return null;
    const label =
      state.phase === 'canceled' || state.phase === 'failed'
        ? t('teamRestitchBoostResume')
        : ready > 0
          ? t('teamRestitchBoostNew', { count: remaining })
          : t('teamRestitchBoostStart');
    return (
      <Button type="button" color="primary" disabled={!connected} onClick={onStart}>
        <Zap size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {label}
      </Button>
    );
  })();

  return (
    <section
      className="team-restitch-boost"
      data-state={complete ? 'complete' : working ? 'working' : state.phase}
      aria-labelledby="team-restitch-boost-title"
    >
      <div className="team-restitch-boost-head">
        <span className="team-restitch-boost-icon" aria-hidden="true">
          <Zap size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        </span>
        <div className="team-restitch-boost-copy">
          <h3 id="team-restitch-boost-title">{t('teamRestitchBoostTitle')}</h3>
          <p>{t('teamRestitchBoostLead')}</p>
        </div>
        {/* Before and after, in the two words the whole feature is about. */}
        <span className="team-restitch-boost-compare" aria-label={t('teamRestitchBoostCompare')}>
          <span>
            <Clock size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamRestitchBoostBefore')}
          </span>
          <span aria-hidden="true">→</span>
          <span className="is-after">
            <Zap size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamRestitchBoostAfter')}
          </span>
        </span>
      </div>

      {!blocked && known && total > 0 && (
        <div className="team-restitch-boost-meter">
          <div className="team-restitch-boost-count">
            {complete ? (
              <strong className="is-complete">
                <CircleCheck size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {date
                  ? t('teamRestitchBoostAllReadyOn', { total, date })
                  : t('teamRestitchBoostAllReady', { total })}
              </strong>
            ) : (
              <strong>{t('teamRestitchBoostReady', { ready: done, total })}</strong>
            )}
            {!complete && ready > 0 && <span>{t('teamRestitchBoostIncludesManual')}</span>}
            {state.failed > 0 && (
              <span>{t('teamRestitchBoostFailed', { count: state.failed })}</span>
            )}
            {state.unsupported > 0 && (
              <span>{t('teamRestitchPrepareUnsupported', { count: state.unsupported })}</span>
            )}
          </div>
          <Progress
            value={fraction * 100}
            color={complete ? 'success' : 'primary'}
            flowing={working && state.phase === 'running'}
            label={t('teamRestitchBoostReady', { ready: done, total })}
          />
        </div>
      )}

      {!connected && !blocked && !working && !complete && (
        <Alert color="warning" variant="soft">
          {t('teamRestitchAgentMissing')}
        </Alert>
      )}

      {(status || action) && (
        <div className="team-restitch-boost-foot">
          <p role="status">{status}</p>
          {action}
        </div>
      )}
    </section>
  );
}

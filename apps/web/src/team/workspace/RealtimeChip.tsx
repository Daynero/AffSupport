import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';

/**
 * A brief drop is normal and self-healing; announcing it immediately would make
 * the header flicker on every tab switch. Only a reconnection that is still
 * unresolved after this long is worth saying out loud.
 */
const RECONNECT_GRACE_MS = 8_000;

/**
 * Says when live updates are not arriving — and nothing at all when they are.
 *
 * The realtime state has been tracked since 001 but rendered nowhere, so a
 * degraded channel was invisible: the space simply stopped changing (finding
 * S5). This is deliberately quiet, because the fallback poll means degraded no
 * longer means broken.
 */
export function RealtimeChip() {
  const { t } = useI18n();
  const { realtimeState } = useTeam();
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    if (realtimeState !== 'reconnecting') {
      setGraceElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setGraceElapsed(true), RECONNECT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [realtimeState]);

  if (realtimeState === 'disabled') {
    return (
      <span className="ui-chip ui-chip-warn" role="status">
        {t('teamRealtimeDisabled')}
      </span>
    );
  }
  if (realtimeState === 'reconnecting' && graceElapsed) {
    return (
      <span className="ui-chip ui-chip-warn" role="status">
        <span className="ui-chip-spinner" aria-hidden="true" />
        {t('teamRealtimeReconnecting')}
      </span>
    );
  }
  return null;
}

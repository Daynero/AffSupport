import { useEffect, useRef, useState } from 'react';
import type { ReconnectSurface } from '../analytics/events';
import { useOptionalAgent } from '../AgentContext';
import type { LinkReason } from '../connection';
import { useI18n, type TranslationKey } from '../i18n';
import { type Translate } from './ui';
import { Button, Chip, Spinner, type UiSize } from './ui/index';

/**
 * The one "Reconnect" (032, FR-010/FR-011).
 *
 * Every surface that says "Soty is not connected" puts this beside the sentence,
 * so the way out is where the problem is. It calls the context's `reconnect`
 * with the surface it sits on, shows the attempt while one runs, and for a
 * moment after it ends says what came of it: "connected", or the reason it did
 * not and therefore what to do next.
 *
 * Never disabled. A press during an attempt joins that attempt rather than
 * being dropped (FR-009), and a stuck attempt times out in the context, so the
 * button is always a button.
 */

/** How long the outcome stays beside the button. */
const RESULT_MS = 4_000;

const REASON_KEY: Record<LinkReason, TranslationKey> = {
  not_running: 'linkReasonNotRunning',
  not_installed: 'linkReasonNotInstalled',
  blocked_by_browser: 'linkBrowserBlocked',
  pairing_rejected: 'linkReasonPairingRejected',
  agent_too_old: 'agentUpdateRequired',
  web_too_old: 'webUpdateBody',
  account_check_required: 'linkReasonAccountRequired',
  account_check_unavailable: 'linkReasonAccountUnavailable',
  update_in_progress: 'linkReasonUpdating',
  timeout: 'linkReasonTimeout',
  unknown: 'linkReasonNotRunning'
};

/** The sentence for a reason the link is not there; "not running" when nothing better is known. */
export function linkReasonText(reason: LinkReason | null | undefined, t: Translate): string {
  return t(REASON_KEY[reason ?? 'unknown']);
}

type Result = { kind: 'connected' } | { kind: 'failed'; text: string };

export function ReconnectAction({
  surface,
  compact = false,
  size,
  className
}: {
  surface: ReconnectSurface;
  /** The header's spelling: the smallest button, nothing beside it but the outcome. */
  compact?: boolean;
  size?: UiSize;
  className?: string;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const attempt = agent?.attempt ?? null;
  const connection = agent?.connection;
  const reason = agent?.reason ?? null;
  const [result, setResult] = useState<Result | null>(null);
  /** Set by a press; the next attempt to end answers it. */
  const awaiting = useRef(false);
  const sawAttempt = useRef(false);

  useEffect(() => {
    if (attempt) {
      sawAttempt.current = true;
      return;
    }
    if (!sawAttempt.current || !awaiting.current) return;
    sawAttempt.current = false;
    awaiting.current = false;
    setResult(
      connection === 'connected'
        ? { kind: 'connected' }
        : { kind: 'failed', text: linkReasonText(reason, t) }
    );
  }, [attempt, connection, reason, t]);

  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), RESULT_MS);
    return () => window.clearTimeout(timer);
  }, [result]);

  if (!agent) return null;

  const pending = attempt !== null;
  const buttonSize = size ?? (compact ? 'xs' : 'sm');
  return (
    <span className={['reconnect-action', className].filter(Boolean).join(' ')}>
      <Button
        variant="secondary"
        size={buttonSize}
        leading={pending ? <Spinner /> : undefined}
        onClick={() => {
          awaiting.current = true;
          setResult(null);
          agent.reconnect(surface);
        }}
      >
        {t(pending ? 'linkReconnecting' : 'linkReconnect')}
      </Button>
      {result && (
        <Chip
          role="status"
          size="xs"
          color={result.kind === 'connected' ? 'success' : 'warning'}
          className="reconnect-action-result"
        >
          {result.kind === 'connected' ? t('linkConnected') : result.text}
        </Chip>
      )}
    </span>
  );
}

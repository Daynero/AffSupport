import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useOptionalAgent } from '../AgentContext';
import { linkOrigin } from '../analytics/link';
import { analytics } from '../analytics/service';
import { fetchAgentDiagnostics } from '../api/client';
import { Alert, Button } from '../components/ui/index';
import { useI18n } from '../i18n';
import { currentBrowserFamily } from '../lib/browser';
import {
  buildDiagnosticsBundle,
  DIAGNOSTICS_BUNDLE_RECORDS,
  diagnosticsBundleRecordCount,
  formatDiagnosticsBundle,
  type AgentDiagnosticsResponse,
  type DiagnosticsBundle as Bundle
} from './diagnostics-bundle';

/** Past any journal (the agent accepts a cursor of up to 15 digits). */
const LAST_CURSOR = 999_999_999_999_999;

/**
 * The support bundle (031 T015, FR-045/FR-054).
 *
 * One button collects; the result is shown whole, in a read-only block, with
 * the record count and a line saying it has gone nowhere. Only then does a
 * second button copy exactly the text on screen. The agent being unreachable
 * is a fact the bundle records (`agent: "unavailable"`), not a reason to show
 * nothing — the web half is often the half that explains the problem.
 */
export function DiagnosticsBundle() {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const outputId = useId();
  const [state, setState] = useState<'idle' | 'collecting' | 'ready'>('idle');
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const collect = useCallback(async () => {
    setState('collecting');
    setCopied(false);
    // Not paired, not running, or refused: the bundle says `unavailable` and
    // still carries everything the page itself knows.
    // The newest records, not the oldest: `since` is a cursor from the start of the
    // journal, so `since=0` returned its first page — on a busy agent hours before the
    // failure being reported (production 2026-11-12, Windows support). An empty page past
    // the end answers with the latest sequence; an older agent without it falls back to 0.
    const end = await fetchAgentDiagnostics(LAST_CURSOR, 1, undefined, true).catch(() => null);
    const latest = typeof end?.nextSeq === 'number' && end.nextSeq > 0 ? end.nextSeq : 0;
    const response: AgentDiagnosticsResponse | null = await fetchAgentDiagnostics(
      Math.max(0, latest - DIAGNOSTICS_BUNDLE_RECORDS),
      DIAGNOSTICS_BUNDLE_RECORDS,
      undefined,
      true
    ).catch(() => null);
    if (!mounted.current) return;
    const lastKnownAgent = agent?.lastKnownAgent ?? null;
    setBundle(
      buildDiagnosticsBundle({
        agent: response,
        web: {
          browserFamily: currentBrowserFamily(),
          origin: linkOrigin(),
          connection: agent?.connection ?? 'checking',
          reason: agent?.reason ?? null,
          lastKnownAgent: lastKnownAgent
            ? {
                version: lastKnownAgent.version,
                buildId: lastKnownAgent.buildId,
                instanceId: lastKnownAgent.instanceId,
                channel: lastKnownAgent.channel,
                capabilities: lastKnownAgent.capabilities
              }
            : null
        }
      })
    );
    setState('ready');
  }, [agent?.connection, agent?.lastKnownAgent, agent?.reason]);

  const shown = bundle ? formatDiagnosticsBundle(bundle) : '';

  const copy = useCallback(async () => {
    if (!shown || !(await writeClipboard(shown))) return;
    analytics.track('diagnostics_copied', { action_identifier: 'copy_bundle' });
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      if (mounted.current) setCopied(false);
    }, 1800);
  }, [shown]);

  return (
    <section className="support-section diagnostics-bundle">
      <h3>{t('diagnosticsBundleTitle')}</h3>
      <p className="support-note">{t('diagnosticsBundleBody')}</p>
      <div className="diagnostics-bundle-actions">
        <Button
          variant="outline"
          size="sm"
          loading={state === 'collecting'}
          onClick={() => void collect()}
          aria-controls={bundle ? outputId : undefined}
        >
          {state === 'collecting' ? t('diagnosticsCollecting') : t('diagnosticsCollect')}
        </Button>
        {bundle && (
          <Button
            variant="outline"
            size="sm"
            className="support-copy"
            onClick={() => void copy()}
            aria-describedby={outputId}
          >
            {copied ? t('diagnosticsCopied') : t('diagnosticsCopy')}
          </Button>
        )}
      </div>
      {bundle && (
        <>
          {bundle.agent === 'unavailable' && (
            <Alert color="warning" variant="soft" live="status">
              {t('diagnosticsAgentUnavailable')}
            </Alert>
          )}
          <p className="support-note">
            {t('diagnosticsRecords', { count: diagnosticsBundleRecordCount(bundle) })}
          </p>
          <pre
            id={outputId}
            className="diagnostics-bundle-output"
            tabIndex={0}
            aria-label={t('diagnosticsBundleTitle')}
            data-testid="diagnostics-bundle-output"
          >
            <code>{shown}</code>
          </pre>
        </>
      )}
    </section>
  );
}

/**
 * The async clipboard where it exists, the selection command where it does
 * not (an insecure origin, an older WebView). Returns whether anything copied.
 */
async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection command.
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'diagnostics-bundle-clipboard';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

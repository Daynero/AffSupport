import { useEffect, useId, useRef, useState } from 'react';
import type {
  LaunchAssignmentReceipt,
  LaunchAssignmentState,
  TeamAccountSummary
} from '@video-compressor/shared';
import {
  LAUNCH_ASSIGNMENTS_CHANGED_EVENT,
  isDefinitiveAssignmentError,
  launchAssignmentsApi,
  type SetLaunchAssignment
} from '../../api/team-launch-assignments';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { LaunchAccountSelector } from './LaunchAccountSelector';
import { launchAction, launchMutation, launchVisible } from './analytics';

/** Operational assignment is independent of saved inputs and immutable results. */
export function LaunchAssignmentControls({
  teamId,
  launchId,
  sourceAgentRowId,
  accounts,
  editable,
  hasResults,
  onAssignmentChange,
  onConfirmed
}: {
  teamId: string;
  launchId: string;
  sourceAgentRowId: string | null;
  accounts: TeamAccountSummary[];
  editable: boolean;
  hasResults: boolean;
  onAssignmentChange?: (state: LaunchAssignmentState | null) => void;
  onConfirmed?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [state, setState] = useState<LaunchAssignmentState | null>(null);
  const [target, setTarget] = useState(sourceAgentRowId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'read' | 'unknown' | 'write' | null>(null);
  const [retryRead, setRetryRead] = useState(0);
  const source = useRef(sourceAgentRowId);
  source.current = sourceAgentRowId;
  const inFlight = useRef(false);
  useEffect(() => {
    onAssignmentChange?.(state);
  }, [state, onAssignmentChange]);
  const pending = useRef<SetLaunchAssignment | null>(null);
  const scope = useRef({ teamId, launchId, editable, mounted: true });
  scope.current = { teamId, launchId, editable, mounted: true };
  const applied = useRef<{
    receipt: LaunchAssignmentReceipt;
    action: 'assign_account' | 'release_account';
  } | null>(null);
  const isCurrent = () =>
    scope.current.mounted && scope.current.teamId === teamId && scope.current.launchId === launchId;
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setState(null);
    setError(null);
    pending.current = null;
    void launchAssignmentsApi.read(teamId, launchId).then(
      result => {
        if (active) {
          setState(result);
          setTarget(result.agentRowId ?? source.current ?? '');
        }
      },
      () => {
        if (active) setError('read');
      }
    );
    return () => {
      active = false;
    };
  }, [teamId, launchId, retryRead]);
  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.teamId === teamId && !pending.current)
        setRetryRead(value => value + 1);
    };
    window.addEventListener(LAUNCH_ASSIGNMENTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(LAUNCH_ASSIGNMENTS_CHANGED_EVENT, refresh);
  }, [teamId]);
  useEffect(() => {
    const proof = applied.current;
    if (
      !proof ||
      state?.version !== proof.receipt.version ||
      state.agentRowId !== proof.receipt.agentRowId
    )
      return;
    launchVisible({ flowId: proof.receipt.requestKey, launchId }, undefined, proof.action);
    applied.current = null;
  }, [state, launchId]);
  async function accept(receipt: LaunchAssignmentReceipt) {
    // A receipt proves this write committed, not that another editor has not
    // changed the current assignment since. Confirm the actual row before proof.
    let current: LaunchAssignmentState;
    try {
      current = await launchAssignmentsApi.read(teamId, launchId);
    } catch {
      // The mutation receipt remains valid even when permission/network loss
      // prevents current-state readback. Never reinterpret it as rejected.
      if (isCurrent()) setError('unknown');
      return;
    }
    if (!isCurrent()) return;
    if (current.version === receipt.version && current.agentRowId === receipt.agentRowId)
      applied.current = {
        receipt,
        action: receipt.agentRowId === null ? 'release_account' : 'assign_account'
      };
    setState(current);
    pending.current = null;
    setError(null);
    void Promise.resolve()
      .then(() => onConfirmed?.())
      .catch(() => {
        if (isCurrent()) setError('read');
      });
  }
  async function save(agentRowId: string | null) {
    if (!scope.current.editable || !state || inFlight.current) return;
    pending.current ??= {
      teamId,
      launchId,
      agentRowId,
      expectedVersion: state.version,
      requestKey: crypto.randomUUID()
    };
    const intent = pending.current;
    if (intent.agentRowId !== agentRowId) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const receipt = await launchMutation(
        { flowId: intent.requestKey, launchId },
        agentRowId === null ? 'release_account' : 'assign_account',
        () => launchAssignmentsApi.set(intent)
      );
      if (isCurrent()) await accept(receipt);
    } catch (cause) {
      if (!isCurrent()) return;
      if (isDefinitiveAssignmentError(cause)) {
        pending.current = null;
        setError('write');
        // A stale CAS is reread explicitly before another assignment is made.
        setState(null);
      } else setError('unknown');
    } finally {
      inFlight.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  async function check() {
    const intent = pending.current;
    if (!intent || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const receipt = await launchAssignmentsApi.readMutation(teamId, intent.requestKey);
      if (!isCurrent()) return;
      if (receipt && receipt.launchId === launchId && receipt.agentRowId === intent.agentRowId) {
        launchAction(
          { flowId: intent.requestKey, launchId },
          intent.agentRowId === null ? 'release_account' : 'assign_account',
          'success'
        );
        await accept(receipt);
      } else setError('unknown');
    } catch {
      if (isCurrent()) setError('unknown');
    } finally {
      inFlight.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  const currentAgent = accounts
    .flatMap(account =>
      account.agents.map(agent => ({
        ...agent,
        label: `${account.name} · ${agent.agentId.slice(-3)}`
      }))
    )
    .find(agent => agent.id === state?.agentRowId);
  const assigned = state?.state === 'assigned';
  const uncertain = error === 'unknown';
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-control bg-surface p-2"
      aria-label={t('launchesAssignmentTitle')}
    >
      <div role="status" className="text-caption text-muted">
        {!state
          ? error
            ? t('launchesAssignmentReadError')
            : t('loading')
          : state.state === 'legacy_unknown'
            ? t('launchesAssignmentLegacy')
            : assigned
              ? t('launchesAssignmentSelected', {
                  account: currentAgent?.label ?? t('launchesAccountUnavailable')
                })
              : t('launchesAssignmentUnassigned')}
      </div>
      {editable && state && (
        <>
          <LaunchAccountSelector
            id={id}
            value={target}
            accounts={accounts}
            disabled={busy || uncertain}
            onChange={setTarget}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!target || busy || uncertain || (assigned && state.agentRowId === target)}
              onClick={() => void save(target)}
            >
              {t(assigned ? 'launchesAssignmentReassign' : 'launchesAssignmentAssign')}
            </Button>
            {(assigned || state.state === 'legacy_unknown') && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || uncertain}
                onClick={() => void save(null)}
              >
                {t(assigned ? 'launchesAssignmentRelease' : 'launchesAssignmentHistoryOnly')}
              </Button>
            )}
          </div>
        </>
      )}
      {hasResults && <p className="text-caption text-muted">{t('launchesAssignmentProvenance')}</p>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-warning-text">
          <span>{t(uncertain ? 'launchesAssignmentUnknown' : 'launchesAssignmentReadError')}</span>
          {uncertain ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void check()}>
                {t('launchesAssignmentCheck')}
              </Button>
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void save(pending.current?.agentRowId ?? null)}
                >
                  {t('retry')}
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setRetryRead(value => value + 1)}>
              {t('retry')}
            </Button>
          )}
        </div>
      )}
      {busy && (
        <span role="status" className="text-caption text-muted">
          {t('launchesAssignmentBusy')}
        </span>
      )}
    </section>
  );
}

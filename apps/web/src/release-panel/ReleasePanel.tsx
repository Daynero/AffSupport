import React, { useEffect, useState } from 'react';
import type { ReleasePanelSnapshot } from '../../../../packages/shared/src/release-automation';
import { Card, Badge, Progress, Alert, Timeline, Button, ConfirmDialog } from '../components/ui';
import { messages as m } from './messages';
import { panelJson } from './client';

export function ReleasePanel({
  snapshot,
  connection,
  error,
  cancel
}: {
  snapshot: ReleasePanelSnapshot | null;
  connection: string;
  error: string | null;
  cancel: () => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const stale = Boolean(
    snapshot &&
    !['completed', 'cancelled'].includes(snapshot.state) &&
    (!snapshot.workerHeartbeatAt || now - Date.parse(snapshot.workerHeartbeatAt) > 30000)
  );
  const title = snapshot ? `${m.title} ${snapshot.version}` : m.title;
  const state = snapshot ? (m.states[snapshot.state] ?? snapshot.state) : m.loading;
  const loadLogs = async () => {
    if (!snapshot?.logRef) return;
    try {
      const result = await panelJson(`/release-panel/api/logs/${snapshot.logRef}`);
      if (result && typeof result === 'object' && 'lines' in result && Array.isArray(result.lines))
        setLogs(result.lines.filter((s): s is string => typeof s === 'string'));
    } catch {
      setCancelError(m.unavailable);
    }
  };
  return (
    <main className="release-panel-shell">
      <header className="release-panel-header">
        <div>
          <h1>{title}</h1>
          <p>{snapshot?.targetId}</p>
        </div>
        <Badge color={connection === 'connected' ? 'success' : 'warning'}>
          {connection === 'connected' ? m.connected : m.reconnecting}
        </Badge>
      </header>
      {error && (
        <Alert color="error" title={m.unavailable}>
          {error}
        </Alert>
      )}
      {cancelError && <Alert color="error">{cancelError}</Alert>}
      <Card
        role="panel"
        title={state}
        aside={<span className="release-panel-percent">{snapshot?.progress.percent ?? 0}%</span>}
      >
        <span className="visually-hidden" role="status" aria-live="polite">
          {state}
        </span>
        <Progress
          value={snapshot?.progress.percent ?? 0}
          label={m.progress}
          valueText={`${snapshot?.progress.percent ?? 0}% — ${m.progress}`}
        />
        <p className="release-panel-muted">{m.progress}</p>
        <p>
          {snapshot?.currentStep
            ? (m.stepNames[snapshot.currentStep] ?? snapshot.currentStep)
            : state}
        </p>
        {snapshot?.waiting && <p>{snapshot.waiting}</p>}
        {snapshot?.nextCheckAt && (
          <p>Наступна перевірка: {new Date(snapshot.nextCheckAt).toLocaleTimeString('uk-UA')}</p>
        )}
        {snapshot?.progressReason && <Alert color="info">{snapshot.progressReason}</Alert>}
        {snapshot?.windowsUrl &&
          /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(
            snapshot.windowsUrl
          ) && (
            <a href={snapshot.windowsUrl} target="_blank" rel="noreferrer">
              Windows CI
            </a>
          )}
        {snapshot?.repair && (
          <p>
            {m.states.repairing}: {snapshot.repair.cause} — {snapshot.repair.state}
          </p>
        )}
        {stale && <Alert color="warning">{m.stale}</Alert>}
        {snapshot?.blocker && (
          <Alert color="warning" title={m.states.needs_owner}>
            {snapshot.blocker.code}
            <p>{snapshot.blocker.detail}</p>
            <p>{snapshot.blocker.requiredAction}</p>
          </Alert>
        )}
      </Card>
      <Card role="surface" title={m.steps}>
        <Timeline
          entries={(snapshot?.progress.steps ?? []).map(step => ({
            id: step.id,
            title: m.stepNames[step.id] ?? step.id,
            meta: m.stepStates[step.status] ?? step.status,
            tone: step.status === 'completed' ? 'success' : 'neutral'
          }))}
        />
      </Card>
      <Card role="section" title={m.details}>
        <p>
          {m.tokens}: {snapshot?.usage == null ? m.unknown : snapshot.usage.toLocaleString('uk-UA')}
        </p>
        <p>
          {m.attempts}: {snapshot?.attempts ?? 0}
        </p>
        <p className="release-panel-muted">{m.monitoring}</p>
        <details>
          <summary>{m.candidates}</summary>
          <ol>
            {snapshot?.candidates.map(id => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ol>
        </details>
        <Button
          variant="ghost"
          onClick={() => {
            void loadLogs();
          }}
        >
          {m.logs}
        </Button>
        {logs.length > 0 && <pre className="release-panel-logs">{logs.join('\n')}</pre>}
        {snapshot && !['completed', 'cancelled', 'cancelling'].includes(snapshot.state) && (
          <Button variant="ghost" color="error" onClick={() => setConfirm(true)}>
            {m.cancel}
          </Button>
        )}
      </Card>
      <ConfirmDialog
        open={confirm}
        title={m.cancel}
        body={m.cancelBody}
        confirmLabel={m.cancel}
        cancelLabel={m.keep}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void cancel().catch((e: unknown) =>
            setCancelError(e instanceof Error ? e.message : m.unavailable)
          );
        }}
      />
    </main>
  );
}

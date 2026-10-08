// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReleasePanel } from '../apps/web/src/release-panel/ReleasePanel';
import { parseSnapshot, newerSnapshot } from '../apps/web/src/release-panel/client';
import type { ReleasePanelSnapshot } from '../packages/shared/src/release-automation';
const snapshot: ReleasePanelSnapshot = {
  schemaVersion: 1,
  taskId: 'task',
  runId: 'run',
  revision: 2,
  generation: 1,
  version: '1.2.5',
  targetId: 'sandbox',
  state: 'waiting',
  candidates: ['run'],
  progress: {
    percent: 42,
    final: false,
    nativePercent: null,
    steps: [{ id: 'windows_smoke', weight: 1, confidence: 'low', status: 'running' }]
  },
  currentStep: 'windows_smoke',
  updatedAt: new Date().toISOString(),
  workerHeartbeatAt: new Date().toISOString(),
  waiting: 'Очікування CI',
  repair: null,
  usage: null,
  attempts: 0,
  blocker: null,
  windowsUrl: null
};
describe('operator panel', () => {
  it('shows confirmed progress, unknown usage and token-free monitoring', () => {
    const cancel = vi.fn();
    render(
      <ReleasePanel snapshot={snapshot} connection="connected" error={null} cancel={cancel} />
    );
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('Очікування CI')).toBeTruthy();
    expect(screen.getByText('Токени ремонту: Невідомо')).toBeTruthy();
    expect(screen.getByText('Моніторинг не викликає модель')).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
  });
  it('keeps stale revisions from rolling progress backwards and rejects schema mismatch', () => {
    expect(newerSnapshot(snapshot, { ...snapshot, revision: 1 })).toBe(snapshot);
    expect(() => parseSnapshot({ ...snapshot, schemaVersion: 2 })).toThrow(
      'UNSUPPORTED_PANEL_SCHEMA'
    );
    expect(() => parseSnapshot({ ...snapshot, progress: { percent: 101 } })).toThrow(
      'UNSUPPORTED_PANEL_SCHEMA'
    );
  });
});

// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToastProvider, useToasts, type ToastContextValue } from '../apps/web/src/components/toast';
import { localStageProgress } from '../apps/web/src/team/explorer/localProgress';

afterEach(cleanup);

describe('local progress stages', () => {
  it('does not invent a denominator during preparation or catalog confirmation', () => {
    expect(
      localStageProgress({
        stage: 'preparing',
        confirmedBytes: 0,
        totalBytes: 0,
        completedItems: 0,
        totalItems: 0
      })
    ).toBe('indeterminate');
    expect(
      localStageProgress({
        stage: 'updating_catalog',
        confirmedBytes: 10,
        totalBytes: 10,
        completedItems: 1,
        totalItems: 1
      })
    ).toBe('indeterminate');
  });

  it('keeps zero-byte transfer indeterminate until its finalize outcome', () => {
    expect(
      localStageProgress({
        stage: 'transferring',
        confirmedBytes: 0,
        totalBytes: 0,
        completedItems: 0,
        totalItems: 1
      })
    ).toBe('indeterminate');
    expect(
      localStageProgress({
        stage: 'done',
        confirmedBytes: 0,
        totalBytes: 0,
        completedItems: 1,
        totalItems: 1,
        succeeded: true
      })
    ).toBe(100);
  });

  it('counts only confirmed bytes or terminal items', () => {
    expect(
      localStageProgress({
        stage: 'transferring',
        confirmedBytes: 3,
        totalBytes: 10,
        completedItems: 0,
        totalItems: 2
      })
    ).toBe(30);
    expect(
      localStageProgress({
        stage: 'moving',
        confirmedBytes: 0,
        totalBytes: 0,
        completedItems: 1,
        totalItems: 4
      })
    ).toBe(25);
    expect(
      localStageProgress({
        stage: 'moving',
        confirmedBytes: 0,
        totalBytes: 0,
        completedItems: 0,
        totalItems: 1
      })
    ).toBe('indeterminate');
  });
});

describe('toast progress accessibility', () => {
  let api: ToastContextValue;
  function Capture() {
    api = useToasts();
    return null;
  }

  it('shows an inventory indeterminate bar and stage/detail text', () => {
    render(
      <ToastProvider>
        <Capture />
      </ToastProvider>
    );
    act(() => {
      api.push({
        tone: 'info',
        text: 'Adding folder',
        sticky: true,
        stageLabel: 'Preparing',
        detail: '2 folders found',
        progress: 'indeterminate'
      });
    });
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(screen.getByText('Preparing')).toBeTruthy();
    expect(screen.getByText('2 folders found')).toBeTruthy();
  });

  it('changes the announced percentage only at meaningful five-point steps', () => {
    render(
      <ToastProvider>
        <Capture />
      </ToastProvider>
    );
    let id = 0;
    act(() => {
      id = api.push({
        tone: 'info',
        text: 'Uploading',
        sticky: true,
        stageLabel: 'Transferring',
        progress: 11
      });
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('11');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Transferring 10%');
    act(() => api.update(id, { progress: 14 }));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Transferring 10%');
    act(() => api.update(id, { progress: 15 }));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Transferring 15%');
  });
});

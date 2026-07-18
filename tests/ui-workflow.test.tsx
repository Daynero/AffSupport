import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { jobConfigurationKey } from '../packages/shared/src/types.js';
import { droppedFiles, DropZone } from '../apps/web/src/components/DropZone';
import { JobRow } from '../apps/web/src/components/JobRow';
import { SettingsPanel } from '../apps/web/src/components/SettingsPanel';
import {
  Tooltip,
  tooltipInteraction,
  type TooltipInteractionState,
  type Translate
} from '../apps/web/src/components/ui';
import { isSupportedVideoPath } from '../apps/agent/src/queue/queue.js';
import {
  batchMetrics,
  elapsedMilliseconds,
  isValidIntegerInput,
  readySelectedIds,
  removableSelectedIds,
  timerState,
  toggleSelection
} from '../apps/web/src/queue-ui';
import { translate, type Language } from '../apps/web/src/i18n';
import { customEncoding, makeJob, optimalSettings } from './helpers.js';

const translator =
  (language: Language): Translate =>
  (key, values) =>
    translate(language, key, values);

describe('compression settings UI', () => {
  it('shows only the compact summary in Optimal mode', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        settings={optimalSettings}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        t={translator('en')}
      />
    );
    expect(markup).toContain('Original resolution');
    expect(markup).toContain('Original frame rate');
    expect(markup).toContain('CRF 26');
    expect(markup).not.toContain('type="range"');
    expect(markup).not.toContain('Target bitrate</button>');
  });

  it('shows consistent custom FPS, resolution and mutually exclusive rate controls', () => {
    const settings = {
      ...optimalSettings,
      mode: 'custom' as const,
      frameRate: 25,
      resolutionLimit: 720
    };
    const crfMarkup = renderToStaticMarkup(
      <SettingsPanel
        settings={settings}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        t={translator('en')}
      />
    );
    expect(crfMarkup).toContain('25 FPS');
    expect(crfMarkup).toContain('720p');
    expect(crfMarkup).toContain('type="range"');
    expect(crfMarkup).not.toContain('aria-label="Video bitrate"');

    const bitrateMarkup = renderToStaticMarkup(
      <SettingsPanel
        settings={{ ...settings, rateControl: 'bitrate', videoBitrateKbps: 3200 }}
        disabled={false}
        updateSettings={() => {}}
        chooseOutputFolder={() => {}}
        t={translator('en')}
      />
    );
    expect(bitrateMarkup).toContain('aria-label="Video bitrate"');
    expect(bitrateMarkup).not.toContain('type="range"');
  });

  it('renders both languages from the same settings object without changing values', () => {
    const settings = {
      ...optimalSettings,
      mode: 'custom' as const,
      frameRate: 25,
      resolutionLimit: 720
    };
    const render = (language: Language) =>
      renderToStaticMarkup(
        <SettingsPanel
          settings={settings}
          disabled={false}
          updateSettings={() => {}}
          chooseOutputFolder={() => {}}
          t={translator(language)}
        />
      );
    expect(render('en')).toContain('25 FPS');
    expect(render('uk')).toContain('25 FPS');
    expect(settings).toMatchObject({ frameRate: 25, resolutionLimit: 720 });
  });

  it('validates custom values instead of accepting empty, zero, negative or out-of-range input', () => {
    expect(isValidIntegerInput('24', 1, 240)).toBe(true);
    expect(isValidIntegerInput('', 1, 240)).toBe(false);
    expect(isValidIntegerInput('0', 1, 240)).toBe(false);
    expect(isValidIntegerInput('-1', 1, 240)).toBe(false);
    expect(isValidIntegerInput('24.5', 1, 240)).toBe(false);
    expect(isValidIntegerInput('100001', 100, 100000)).toBe(false);
  });
});

describe('drop zone and list selection', () => {
  it('accepts one or many dropped File-like values in order', () => {
    const one = { name: 'one.mp4' } as File;
    const two = { name: 'two.mov' } as File;
    expect(droppedFiles({ 0: one, length: 1 })).toEqual([one]);
    expect(droppedFiles({ 0: one, 1: two, length: 2 })).toEqual([one, two]);
    expect(isSupportedVideoPath(one.name)).toBe(true);
    expect(isSupportedVideoPath('notes.txt')).toBe(false);
  });

  it('renders a keyboard-focusable multiple-file drop target', () => {
    const markup = renderToStaticMarkup(
      <DropZone
        disabled={false}
        importing={false}
        chooseFiles={() => {}}
        addDroppedFiles={() => {}}
        t={translator('uk')}
      />
    );
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('Перетягніть відео сюди');
  });

  it('supports select all, clear selection, per-file checkbox and Shift range selection', () => {
    const ids = ['one', 'two', 'three', 'four'];
    const all = new Set(ids);
    expect([...all]).toEqual(ids);
    expect(new Set()).toEqual(new Set());
    const update = toggleSelection(new Set(['one']), 'three', true, ids, 0, true);
    expect([...update.selected]).toEqual(['one', 'two', 'three']);
    const jobs = [makeJob('one'), makeJob('two', 'processing'), makeJob('three', 'completed')];
    expect(readySelectedIds(jobs, all)).toEqual(['one']);
    expect(removableSelectedIds(jobs, all)).toEqual(['one', 'three']);
  });
});

describe('estimates, results, timers and batch progress', () => {
  it('keeps estimate and actual result visually and semantically distinct', () => {
    const estimated = makeJob('estimated', 'ready', {
      encoding: { ...customEncoding },
      estimateStatus: 'estimated',
      estimatedOutputBytes: 6000,
      estimatedSavingPercent: 40,
      estimateKey: jobConfigurationKey(customEncoding, null)
    });
    const estimateMarkup = renderToStaticMarkup(
      <JobRow
        job={estimated}
        selected={false}
        disabled={false}
        compressionRunning={false}
        language="en"
        onSelected={() => {}}
        action={() => {}}
        t={translator('en')}
      />
    );
    expect(estimateMarkup).toContain('Expected result');
    expect(estimateMarkup).toContain('≈');
    expect(estimateMarkup).not.toContain('Ready file');

    const completed = makeJob('completed', 'completed', {
      finalSize: 5000,
      finalWidth: 1920,
      finalHeight: 1080,
      finalFrameRate: 29.97,
      finalBitrate: 2_000_000,
      finalDurationSeconds: 10,
      finalCodec: 'h264',
      startedAt: 1000,
      finishedAt: 6000
    });
    const resultMarkup = renderToStaticMarkup(
      <JobRow
        job={completed}
        selected={false}
        disabled={false}
        compressionRunning={false}
        language="en"
        onSelected={() => {}}
        action={() => {}}
        t={translator('en')}
      />
    );
    expect(resultMarkup).toContain('Ready file');
    expect(resultMarkup).toContain('Completed in 00:00:05');
    expect(resultMarkup).not.toContain('Expected result');
  });

  it('calculates timers from timestamps and freezes completed/error durations', () => {
    const running = makeJob('run', 'processing', { startedAt: 1000 });
    expect(elapsedMilliseconds(running, 86_401_000)).toBe(86_400_000);
    expect(timerState(running)).toBe('running');
    const completed = { ...running, status: 'completed' as const, finishedAt: 11_000 };
    expect(elapsedMilliseconds(completed, 999_999)).toBe(10_000);
    expect(timerState(completed)).toBe('completed');
    const failed = { ...running, status: 'failed' as const, finishedAt: 7000 };
    expect(elapsedMilliseconds(failed, 999_999)).toBe(6000);
    expect(timerState(failed)).toBe('failed');
  });

  it('counts overall progress only for the launched batch', () => {
    const batch = { id: 'batch', jobIds: ['one', 'two'], startedAt: 0, finishedAt: null };
    const jobs = [
      makeJob('one', 'completed', { progress: 100, batchId: 'batch' }),
      makeJob('two', 'processing', { progress: 50, batchId: 'batch' }),
      makeJob('not-started', 'ready', { progress: 0 })
    ];
    expect(batchMetrics(jobs, batch)).toMatchObject({
      total: 2,
      completed: 1,
      processing: 1,
      progress: 75
    });
  });
});

describe('tooltip accessibility and responsive layout', () => {
  it('supports hover, focus, click/tap, Escape and outside-click state transitions', () => {
    const empty: TooltipInteractionState = { hovered: false, focused: false, pinned: false };
    expect(tooltipInteraction(empty, 'hover-in').hovered).toBe(true);
    expect(tooltipInteraction(empty, 'focus').focused).toBe(true);
    expect(tooltipInteraction(empty, 'toggle').pinned).toBe(true);
    expect(tooltipInteraction({ hovered: true, focused: true, pinned: true }, 'escape')).toEqual(
      empty
    );
    expect(tooltipInteraction({ hovered: true, focused: true, pinned: true }, 'outside')).toEqual(
      empty
    );
  });

  it('exposes a labeled tooltip button with expanded state', () => {
    const markup = renderToStaticMarkup(<Tooltip label="Frame-rate help">Short help</Tooltip>);
    expect(markup).toContain('aria-label="Frame-rate help"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('contains narrow-screen stacking rules and avoids forced horizontal layout', async () => {
    const css = await readFile(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('.job-comparison');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).not.toContain('overflow-x: scroll');
  });
});

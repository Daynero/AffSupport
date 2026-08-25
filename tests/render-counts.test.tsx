import { describe, expect, it } from 'vitest';
import { reconcileQueue } from '../apps/web/src/api/reconcile-queue';
import { makeJob } from './helpers.js';
import type { QueueState } from '@video-compressor/shared';

/**
 * A live update must not rebuild rows whose data did not change.
 *
 * Every broadcast arrives as freshly parsed JSON, so every job in it is a new
 * object even when nothing about it moved. React compares by reference, so a
 * progress tick on one job used to re-render the whole queue: two hundred rows
 * rebuilt, several times a second, to redraw one number.
 *
 * Asserting on identity rather than on a render counter is deliberate. A
 * counter measures one component's memoisation and would keep passing if the
 * data underneath it started churning; identity is the property the rendering
 * actually depends on, at the point where it is decided.
 */

function stateWith(jobs: QueueState['jobs']): QueueState {
  return {
    jobs,
    running: false,
    tools: { ffmpeg: true, ffprobe: true },
    settings: {} as QueueState['settings'],
    batch: null,
    warning: null
  } as QueueState;
}

describe('a snapshot that changed one job', () => {
  it('keeps every other job identical', () => {
    const first = makeJob('a', 'ready');
    const second = makeJob('b', 'processing', { progress: 10 });
    const previous = stateWith([first, second]);

    // What arrives over the wire: the same data, freshly parsed, with one
    // number moved.
    const arriving = stateWith([
      JSON.parse(JSON.stringify(first)),
      { ...JSON.parse(JSON.stringify(second)), progress: 20 }
    ]);

    const reconciled = reconcileQueue(previous, arriving);
    expect(reconciled.jobs[0]).toBe(first);
    expect(reconciled.jobs[1]).not.toBe(second);
    expect(reconciled.jobs[1].progress).toBe(20);
  });

  it('keeps the list itself identical when nothing changed', () => {
    const jobs = [makeJob('a', 'ready'), makeJob('b', 'ready')];
    const previous = stateWith(jobs);
    const arriving = stateWith(JSON.parse(JSON.stringify(jobs)));

    // The case that matters most: a heartbeat that changes nothing should cost
    // nothing, including for a component subscribed to the list rather than to
    // a row.
    expect(reconcileQueue(previous, arriving).jobs).toBe(previous.jobs);
  });

  it('replaces the list when a job is removed', () => {
    const first = makeJob('a', 'ready');
    const second = makeJob('b', 'ready');
    const previous = stateWith([first, second]);
    const arriving = stateWith([JSON.parse(JSON.stringify(first))]);

    const reconciled = reconcileQueue(previous, arriving);
    expect(reconciled.jobs).not.toBe(previous.jobs);
    expect(reconciled.jobs[0]).toBe(first);
  });

  it('replaces the list when the order changed', () => {
    const first = makeJob('a', 'ready');
    const second = makeJob('b', 'ready');
    const previous = stateWith([first, second]);
    const arriving = stateWith([
      JSON.parse(JSON.stringify(second)),
      JSON.parse(JSON.stringify(first))
    ]);

    // Same jobs, different sequence — which is a change to what is rendered
    // even though no row's contents moved.
    expect(reconcileQueue(previous, arriving).jobs).not.toBe(previous.jobs);
  });

  it('notices a change inside the nested encoding settings', () => {
    const job = makeJob('a', 'ready');
    const previous = stateWith([job]);
    const arriving = stateWith([
      { ...JSON.parse(JSON.stringify(job)), encoding: { ...job.encoding, crf: 30 } }
    ]);

    // A shallow comparison that stopped at the top level would call these equal
    // and freeze the row on the old settings.
    expect(reconcileQueue(previous, arriving).jobs[0]).not.toBe(job);
  });

  it('passes the first snapshot through untouched', () => {
    const arriving = stateWith([makeJob('a', 'ready')]);
    expect(reconcileQueue(null, arriving)).toBe(arriving);
  });
});

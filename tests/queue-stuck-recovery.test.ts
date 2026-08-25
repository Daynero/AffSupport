import { describe, expect, it } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob } from './helpers.js';

/**
 * Reported from real use, twice in one day: the Compress button greyed out with
 * "compression already running" beside it, above a batch panel reading 0
 * queued, 0 processing, 0 completed, 0 failed. The interface contradicted
 * itself, and the only way out was to quit the application.
 *
 * The cause was two answers to one question. The panel counts jobs by status;
 * the busy flag reads an internal activity value. An activity left pointing at
 * a job that had been removed, or had already finished, kept saying "encoding"
 * — so the queue reported itself busy while holding nothing at all. The drain
 * watchdog would have cleared it, except that it retires whenever no batch is
 * open and arms only inside `start()`, which is the one path a stuck queue
 * cannot take: the button that calls it is disabled by the state it would fix.
 *
 * These stage each way the two can disagree and assert the queue tells the
 * truth about itself.
 */

function queue() {
  return new JobQueue({ ffmpeg: true, ffprobe: true }, () => {});
}

/** Puts the queue in the state the users saw, without going through an encode. */
function strandActivity(instance: JobQueue, jobId: string) {
  // Reaching past the type is the point: this is the corrupt state being
  // reproduced, and no supported call produces it deliberately.
  (instance as unknown as { current: unknown }).current = {
    kind: 'encoding',
    jobId,
    abort: new AbortController(),
    child: null,
    estimating: false
  };
}

describe('a queue that believes it is busy', () => {
  it('does not report itself running when the job is gone', () => {
    const instance = queue();
    strandActivity(instance, 'a-job-that-was-removed');

    // What the user saw: no jobs at all, and "already running".
    expect(instance.state().jobs).toEqual([]);
    expect(instance.running()).toBe(false);
    expect(instance.state().running).toBe(false);
  });

  it('does not report itself running when the job has finished', () => {
    const instance = queue();
    const done = makeJob('done-job', 'completed');
    (instance as unknown as { jobs: unknown[] }).jobs = [done];
    strandActivity(instance, done.id);

    // A completed job is not something being encoded, whatever the activity
    // value still says about it.
    expect(instance.running()).toBe(false);
  });

  it('still reports itself running for a job that really is in flight', () => {
    const instance = queue();
    const live = makeJob('live-job', 'processing');
    (instance as unknown as { jobs: unknown[] }).jobs = [live];
    strandActivity(instance, live.id);

    // The correction must not become a way to start a second encode on top of
    // a running one, which would be a far worse bug than the one being fixed.
    expect(instance.running()).toBe(true);
  });

  it('reports the contradiction in diagnostics while it exists', () => {
    const instance = queue();
    strandActivity(instance, 'a-job-that-was-removed');
    const liveness = instance.liveness();

    // The half that turns an hour of reading source into a glance at a page:
    // the activity names a job, and that job is not live.
    expect(liveness.activityJobId).toBe('a-job-that-was-removed');
    expect(liveness.activityJobLive).toBe(false);
    expect(liveness.jobs).toBe(0);
  });

  it('reports liveness that agrees with the panel counters', () => {
    const instance = queue();
    const live = makeJob('live-job', 'processing');
    (instance as unknown as { jobs: unknown[] }).jobs = [live];
    strandActivity(instance, live.id);
    const liveness = instance.liveness();

    expect(liveness.running).toBe(true);
    expect(liveness.byStatus.processing).toBe(1);
    // Whatever the two numbers are, they now come from a state that agrees
    // with itself.
    expect(liveness.activityJobLive).toBe(true);
  });
});

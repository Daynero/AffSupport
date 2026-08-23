import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_LIFECYCLE,
  LANDING_JOB_LIFECYCLE,
  TRANSCRIPTION_LIFECYCLE
} from '../packages/shared/src/lifecycle.js';
import {
  INTERLEAVING_SCENARIOS,
  REFERENCE_SCENARIO,
  actionsIn,
  scenarioFromLifecycle,
  selfDirectedEdges,
  toolsIn,
  userDirectedEdges,
  type Scenario
} from './support/interleaving-scenarios.js';

/**
 * The scenarios, checked as data before anything walks them.
 *
 * SC-001 asks for a sequence of at least twenty steps across at least three tools. That is a
 * claim about the *test suite*, and a claim about a test suite that a human has to verify by
 * reading is a claim nobody re-checks after the first time. Keeping the sequences as data is
 * what makes it countable here instead.
 *
 * The consistency checks below matter for a duller reason: a scenario that stops a job it
 * never added fails somewhere inside the end-to-end harness, with a message about a missing
 * identifier rather than about the mistake in the sequence.
 */

describe('the reference interleaving scenario', () => {
  it('is at least twenty steps long', () => {
    // Counted over steps that *do* something. Padding a sequence with assertions would meet
    // the number without exercising anything more.
    expect(actionsIn(REFERENCE_SCENARIO).length).toBeGreaterThanOrEqual(20);
  });

  it('crosses at least three tools', () => {
    expect(toolsIn(REFERENCE_SCENARIO).length).toBeGreaterThanOrEqual(3);
  });

  it('observes the machine after every step', () => {
    // The point of the sequence is the moments *between* operations. A scenario that only
    // looked at the end would miss a leak that appears at step 7 and is tidied up by step 19,
    // and the user's machine was busy for those twelve steps regardless.
    expect(REFERENCE_SCENARIO.checkpointEvery).toBe(true);
  });

  it('interleaves rather than running one tool after another', () => {
    // A sequence that finished with the compressor before touching transcription would be
    // three short scenarios in a trench coat. What is under test is what happens when two
    // tools are live at once, so at least one tool has to be started while another is still
    // between its own start and its own stop.
    const started = new Set<string>();
    let overlapped = false;
    for (const step of REFERENCE_SCENARIO.steps) {
      if (step.do === 'start') {
        if (started.size > 0 && !started.has(step.tool)) overlapped = true;
        started.add(step.tool);
      }
      if (step.do === 'stopAll') started.delete(step.tool);
    }
    expect(overlapped).toBe(true);
  });
});

describe('every scenario', () => {
  const cases = INTERLEAVING_SCENARIOS.map(scenario => [scenario.id, scenario] as const);

  it('has a unique id', () => {
    const ids = INTERLEAVING_SCENARIOS.map(scenario => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(cases)('%s only touches jobs it added', (_id, scenario: Scenario) => {
    const added = new Set<string>();
    const unknown: string[] = [];
    for (const step of scenario.steps) {
      if (step.do === 'add') added.add(step.jobRef);
      else if ('jobRef' in step && !added.has(step.jobRef)) unknown.push(step.jobRef);
    }

    expect(unknown).toEqual([]);
  });

  it.each(cases)('%s says why it exists', (_id, scenario: Scenario) => {
    // The intent is printed when a step fails. "Step 14 disagreed" is a bug report nobody
    // can act on; "step 14 of: three tools survive a stop-all without either reporting work
    // the machine is not doing" is one they can.
    expect(scenario.intent.length).toBeGreaterThan(20);
  });
});

describe('scenarios derived from the transition tables', () => {
  /**
   * The join between FR-019 and FR-020.
   *
   * A declaration nothing walks and a harness that walks a hand-written list are two things
   * that drift. Deriving the sequence from the table means a state added next year turns up
   * in the interleaving suite by itself — or, if no user action can reach it, turns up in the
   * list below where somebody has to say why.
   */
  it('walks every user-initiated edge of the compression table', () => {
    const generated = scenarioFromLifecycle('compressor', COMPRESSION_LIFECYCLE, 'clip-a.mp4');
    const walked = new Set(
      generated.steps.filter(step => step.do === 'expect').map(step => step.status)
    );

    for (const edge of userDirectedEdges(COMPRESSION_LIFECYCLE))
      expect(walked, `no step reaches ${edge}`).toContain(edge.split('->')[1]);
  });

  it('names the transitions no user action can request', () => {
    // These are what the application does on its own: work finishing, work failing, a
    // recovery re-probing an output whose encode had already succeeded. Listing them is the
    // difference between "the generator covers the table" and "the generator covers the part
    // of the table it happens to know about".
    expect(selfDirectedEdges(COMPRESSION_LIFECYCLE).sort()).toEqual([
      'analyzing->failed',
      'analyzing->ready',
      'interrupted->completed',
      'interrupted->failed',
      'processing->analyzing',
      'processing->completed',
      'processing->failed',
      'queued->ready'
    ]);
  });

  it.each([
    ['compression', COMPRESSION_LIFECYCLE],
    ['transcription', TRANSCRIPTION_LIFECYCLE],
    ['landing-job', LANDING_JOB_LIFECYCLE]
  ] as const)('%s generates a scenario that only touches jobs it added', (_id, lifecycle) => {
    const generated = scenarioFromLifecycle('compressor', lifecycle, 'clip-a.mp4');
    const added = new Set<string>();
    const unknown: string[] = [];
    for (const step of generated.steps) {
      if (step.do === 'add') added.add(step.jobRef);
      else if ('jobRef' in step && !added.has(step.jobRef)) unknown.push(step.jobRef);
    }

    expect(unknown).toEqual([]);
    expect(generated.checkpointEvery).toBe(true);
  });
});

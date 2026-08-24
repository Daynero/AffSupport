/**
 * What a user actually does, written down as data.
 *
 * The guarantee this feature exists to provide is that what the screen says a job is doing
 * is what the machine is doing — during a stop, after a stop, while another tool starts,
 * after a restart, on both platforms. That is not a property of any single operation; it is
 * a property of *sequences*, and the sequences that break it are the ones nobody thought to
 * write a test for.
 *
 * So the sequences are data rather than imperative test code, for two reasons. A scenario's
 * length and tool coverage become **countable** — SC-001 asks for at least twenty steps
 * across at least three tools, and a claim like that is worth nothing if a human has to
 * verify it by reading. And steps can be **generated from the transition tables**, so the
 * declaration in `packages/shared/src/lifecycle.ts` and the interleaving harness reinforce
 * each other instead of drifting apart.
 */

/**
 * The tools a scenario can drive.
 *
 * Deliberately not `SotyToolId`. That union is the set of tool *cards* the interface offers,
 * and media actions have no card — they start from the file manager's context menu. They are
 * exactly the kind of work that runs while the user is looking at something else, which is
 * what makes them worth interleaving.
 */
export type ToolId =
  'compressor' | 'transcription' | 'landingOptimizer' | 'landingPreview' | 'mediaActions';

/**
 * One thing that happens.
 *
 * `jobRef` is a name the scenario gives a job, not an identifier the agent knows: the real id
 * is minted when the job is added, and a scenario that hard-coded one could only ever run
 * once.
 */
export type Step =
  /** Put a file in front of a tool. `fixture` names a file the harness knows how to make. */
  | { do: 'add'; tool: ToolId; fixture: string; jobRef: string }
  | { do: 'start'; tool: ToolId; jobRef: string }
  | { do: 'stop'; tool: ToolId; jobRef: string }
  | { do: 'stopAll'; tool: ToolId }
  /** Run something that already finished, failed or was stopped. */
  | { do: 'rerun'; tool: ToolId; jobRef: string }
  /** Kill the local app without warning and start it again over the same state. */
  | { do: 'restartAgent' }
  /** Suspend and resume the machine, as closing a laptop lid does. */
  | { do: 'sleepWake' }
  | { do: 'setLimit'; percent: number }
  /** Assert what the tool reports. The machine is checked separately, after every step. */
  | { do: 'expect'; tool: ToolId; jobRef: string; status: string };

export interface Scenario {
  id: string;
  /** Why this sequence is worth walking, in one line. Appears in the failure message. */
  intent: string;
  steps: readonly Step[];
  /**
   * Observe the machine after every step rather than only at the end.
   *
   * A leak that appears at step 7 and is cleaned up by step 19 is still a leak — the user's
   * machine was busy for twelve steps — and only a per-step checkpoint can name where it
   * started.
   */
  checkpointEvery: boolean;
}

/** Every tool a scenario touches. */
export function toolsIn(scenario: Scenario): ToolId[] {
  const tools = new Set<ToolId>();
  for (const step of scenario.steps) if ('tool' in step) tools.add(step.tool);
  return [...tools];
}

/** Steps that actually do something, as opposed to asserting what already happened. */
export function actionsIn(scenario: Scenario): Step[] {
  return scenario.steps.filter(step => step.do !== 'expect');
}

/**
 * The reference sequence.
 *
 * Built around the moments the audit found nobody had tested rather than around a tidy
 * narrative: a stop that lands while another tool is starting, a stop-all that has to leave
 * a second tool's work alone, a re-run of something that was stopped, a restart with work
 * in flight, and a limit change applied to work already running.
 */
const CROSS_TOOL_STOP_AND_RESTART: Scenario = {
  id: 'cross-tool-stop-and-restart',
  intent:
    'Three tools running together survive a stop, a stop-all, a limit change and a restart ' +
    'without either tool reporting work the machine is not doing.',
  checkpointEvery: true,
  steps: [
    { do: 'add', tool: 'compressor', fixture: 'clip-a.mp4', jobRef: 'clipA' },
    { do: 'add', tool: 'compressor', fixture: 'clip-b.mp4', jobRef: 'clipB' },
    { do: 'add', tool: 'transcription', fixture: 'speech.mp3', jobRef: 'speech' },
    { do: 'add', tool: 'landingOptimizer', fixture: 'landing/', jobRef: 'landing' },
    { do: 'add', tool: 'landingPreview', fixture: 'catalogue/', jobRef: 'preview' },
    { do: 'add', tool: 'mediaActions', fixture: 'photo.png', jobRef: 'photo' },

    { do: 'start', tool: 'compressor', jobRef: 'clipA' },
    { do: 'expect', tool: 'compressor', jobRef: 'clipA', status: 'processing' },

    // A second tool starting while the first is mid-encode. The two share one machine and
    // one budget, and this is where "the lever only covers the compressor" would show.
    { do: 'start', tool: 'transcription', jobRef: 'speech' },
    { do: 'expect', tool: 'transcription', jobRef: 'speech', status: 'processing' },

    // A Finder-initiated conversion, started from outside the interface entirely. It has no
    // window of its own, which is exactly why it is easy to leave running.
    { do: 'start', tool: 'mediaActions', jobRef: 'photo' },

    { do: 'setLimit', percent: 40 },

    // Stopping one job of a batch must not stop the batch, and must not touch the other tool.
    { do: 'stop', tool: 'compressor', jobRef: 'clipA' },
    { do: 'expect', tool: 'compressor', jobRef: 'clipA', status: 'cancelled' },
    { do: 'expect', tool: 'transcription', jobRef: 'speech', status: 'processing' },

    { do: 'start', tool: 'landingOptimizer', jobRef: 'landing' },
    { do: 'expect', tool: 'landingOptimizer', jobRef: 'landing', status: 'processing' },

    // A fourth tool joins while three are already live. Rendering a preview catalogue is the
    // heaviest thing this application does per unit of visible progress.
    { do: 'start', tool: 'landingPreview', jobRef: 'preview' },

    // Stop everything in one tool. The other two carry on — a "stop all" that reached across
    // tools would silently discard work the user never asked to stop.
    { do: 'stopAll', tool: 'compressor' },
    { do: 'expect', tool: 'transcription', jobRef: 'speech', status: 'processing' },
    { do: 'expect', tool: 'landingOptimizer', jobRef: 'landing', status: 'processing' },

    // Re-running something that was stopped. There is no resume anywhere in the local app,
    // so this has to start from the beginning and say so.
    { do: 'rerun', tool: 'compressor', jobRef: 'clipA' },
    { do: 'expect', tool: 'compressor', jobRef: 'clipA', status: 'processing' },

    { do: 'setLimit', percent: 100 },

    // The laptop lid closes mid-run.
    { do: 'sleepWake' },

    // And the app is killed outright with work in flight. What the next launch reports is
    // the whole of FR-006: interrupted is not the same as failed.
    { do: 'restartAgent' },
    { do: 'expect', tool: 'compressor', jobRef: 'clipA', status: 'interrupted' },
    { do: 'expect', tool: 'transcription', jobRef: 'speech', status: 'interrupted' },

    { do: 'rerun', tool: 'compressor', jobRef: 'clipA' },
    { do: 'stopAll', tool: 'compressor' },
    { do: 'stopAll', tool: 'transcription' },
    { do: 'stopAll', tool: 'landingOptimizer' },
    { do: 'stopAll', tool: 'landingPreview' },
    { do: 'stopAll', tool: 'mediaActions' }
  ]
};

/**
 * A short sequence about one thing: a stop landing in the same moment as a start.
 *
 * Kept separate from the long scenario because a failure here has a single obvious cause,
 * and burying it inside twenty other steps would make it harder to read, not easier.
 */
const STOP_RACES_START: Scenario = {
  id: 'stop-races-start',
  intent: 'A stop and a start that arrive together leave exactly one of them in effect.',
  checkpointEvery: true,
  steps: [
    { do: 'add', tool: 'compressor', fixture: 'clip-a.mp4', jobRef: 'clipA' },
    { do: 'add', tool: 'mediaActions', fixture: 'photo.png', jobRef: 'photo' },
    { do: 'start', tool: 'compressor', jobRef: 'clipA' },
    { do: 'start', tool: 'mediaActions', jobRef: 'photo' },
    { do: 'stopAll', tool: 'compressor' },
    { do: 'stopAll', tool: 'mediaActions' },
    { do: 'expect', tool: 'compressor', jobRef: 'clipA', status: 'cancelled' },
    { do: 'expect', tool: 'mediaActions', jobRef: 'photo', status: 'cancelled' }
  ]
};

/**
 * Which user action causes which transition.
 *
 * This is the join between the two halves of the guarantee. FR-019 says every transition is
 * declared; FR-020 says the machine agrees with what is reported at every step. They only
 * reinforce each other if the sequences are derived from the declaration — otherwise a state
 * added to a table next year is enforced but never *walked*, and the interleaving suite keeps
 * passing while covering one edge less than it used to.
 *
 * Only user-initiated edges appear here, and that is the honest boundary: a scenario is a
 * list of things a person does. `processing → completed` is not something anyone asks for —
 * it is what happens when the work finishes — and pretending a step could request it would
 * make the coverage number a fiction.
 */
const ACTION_FOR_EDGE: Readonly<Record<string, Step['do']>> = {
  'ready->queued': 'start',
  'queued->processing': 'start',
  'queued->cancelled': 'stop',
  'processing->cancelled': 'stop',
  'completed->ready': 'rerun',
  'failed->ready': 'rerun',
  'cancelled->ready': 'rerun',
  'interrupted->ready': 'rerun',
  'completed->queued': 'rerun',
  'failed->queued': 'rerun',
  'cancelled->queued': 'rerun',
  'interrupted->queued': 'rerun',
  'processing->interrupted': 'restartAgent'
};

interface LifecycleShape {
  readonly id: string;
  readonly transitions: Readonly<Record<string, readonly string[] | undefined>>;
}

/** Every declared edge of a lifecycle, as `from->to`. */
function edgeKeys(lifecycle: LifecycleShape): string[] {
  const keys: string[] = [];
  for (const from of Object.keys(lifecycle.transitions))
    for (const to of lifecycle.transitions[from] ?? []) keys.push(`${from}->${to}`);
  return keys;
}

/**
 * Edges no sequence of user actions can request.
 *
 * Named rather than skipped. These are the transitions the application makes on its own —
 * work finishing, work failing, a recovery re-probing an output — and a generator that
 * quietly omitted them would report full coverage of a table it only half walks.
 */
export function selfDirectedEdges(lifecycle: LifecycleShape): string[] {
  return edgeKeys(lifecycle).filter(key => !(key in ACTION_FOR_EDGE));
}

/** Edges a scenario can drive, for the tool that owns this lifecycle. */
export function userDirectedEdges(lifecycle: LifecycleShape): string[] {
  return edgeKeys(lifecycle).filter(key => key in ACTION_FOR_EDGE);
}

/**
 * Builds a scenario that walks every user-initiated edge of one lifecycle.
 *
 * Generated rather than written, so a state added to the table appears in the interleaving
 * suite without anyone remembering to add it — and, if it is a state no user action can
 * reach, appears in `selfDirectedEdges` where it has to be explained instead.
 */
export function scenarioFromLifecycle(
  tool: ToolId,
  lifecycle: LifecycleShape,
  fixture: string
): Scenario {
  const jobRef = `${tool}-generated`;
  const steps: Step[] = [{ do: 'add', tool, fixture, jobRef }];

  for (const key of userDirectedEdges(lifecycle)) {
    const action = ACTION_FOR_EDGE[key] as Step['do'];
    const to = key.split('->')[1] as string;
    if (action === 'restartAgent') steps.push({ do: 'restartAgent' });
    else if (action === 'start') steps.push({ do: 'start', tool, jobRef });
    else if (action === 'stop') steps.push({ do: 'stop', tool, jobRef });
    else if (action === 'rerun') steps.push({ do: 'rerun', tool, jobRef });
    steps.push({ do: 'expect', tool, jobRef, status: to });
  }

  return {
    id: `generated-${lifecycle.id}`,
    intent: `Every user-initiated transition the ${lifecycle.id} table declares, walked in order.`,
    steps,
    checkpointEvery: true
  };
}

export const INTERLEAVING_SCENARIOS: readonly Scenario[] = [
  CROSS_TOOL_STOP_AND_RESTART,
  STOP_RACES_START
];

/** The scenario SC-001 is about: at least twenty steps across at least three tools. */
export const REFERENCE_SCENARIO = CROSS_TOOL_STOP_AND_RESTART;

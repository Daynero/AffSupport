import type { InspectData } from './types.js';
const STAGES = ['ownership', 'enroll', 'delegate', 'confirm', 'ready'] as const;
/** Generic operation completion is one setup stage, never proof of completed media work. */
export function inspectBackgroundSetup(value: InspectData): InspectData {
  if (!value.found || value.capability !== 'team.background_setup') return value;
  const events = value.events.filter(event =>
    STAGES.some(stage => event.properties.flow_step === `background_setup_${stage}`)
  );
  const stageOf = (step: unknown) => STAGES.find(stage => step === `background_setup_${stage}`);
  const expected = STAGES.filter(
    stage =>
      ['ownership', 'ready'].includes(stage) ||
      events.some(event => stageOf(event.properties.flow_step) === stage)
  );
  const observed = STAGES.filter(stage =>
    events.some(
      event =>
        stageOf(event.properties.flow_step) === stage && event.event_name === 'operation_completed'
    )
  );
  const latest = events.at(-1);
  const terminal = [...events]
    .reverse()
    .find(
      event =>
        ['operation_failed', 'operation_cancelled'].includes(event.event_name) ||
        (event.event_name === 'operation_completed' &&
          event.properties.flow_step === 'background_setup_ready')
    );
  return {
    ...value,
    stages: { expected, observed, missing: expected.filter(stage => !observed.includes(stage)) },
    terminal: terminal
      ? {
          event: terminal.event_name,
          outcome:
            terminal.event_name === 'operation_failed'
              ? 'failure'
              : terminal.event_name === 'operation_cancelled'
                ? 'cancelled'
                : 'success',
          occurred_at: terminal.occurred_at
        }
      : null,
    last_proven_stage: latest
      ? `${stageOf(latest.properties.flow_step)}_${latest.event_name === 'operation_completed' ? 'confirmed' : latest.event_name === 'operation_started' ? 'started' : latest.event_name === 'operation_cancelled' ? 'canceled' : 'failed'}`
      : null,
    agent: {
      ...value.agent,
      note: `${value.agent.note ?? ''} Setup readiness is separate from accepted work, native execution and visible results. Missing or delayed setup signals do not prove missing credentials; protected native status is fallback evidence.`.trim()
    }
  };
}

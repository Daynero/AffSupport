import { describe, expect, it } from 'vitest';
import {
  TranscriptionAttemptJournal,
  transcriptionDiagnosticRunId
} from '../apps/agent/src/transcription/diagnostics';
import { DiagnosticsLog } from '../apps/agent/src/server/diagnostics-log';
import type { DiagnosticProps } from '../apps/agent/src/server/diagnostics-log';
const job = '81000000-0000-4000-8000-000000000001';
const attempt = '81000000-0000-4000-8000-000000000002';
describe('bounded original transcription evidence', () => {
  it('reserves saved and terminal beyond many recovery windows, with no content', () => {
    const log = new DiagnosticsLog();
    const produced: { code: string; props: DiagnosticProps }[] = [];
    const journal = new TranscriptionAttemptJournal(job, attempt, (code, props) => {
      produced.push({ code, props });
      log.record('transcription', code, props);
    });
    for (let i = 0; i < 30; i++) {
      journal.stage('transcribe');
      journal.stage('transcribe');
      journal.stage('recover');
    }
    journal.stage('save');
    journal.stage('saved');
    journal.stage('saved');
    journal.terminal('success');
    journal.terminal('success');
    expect(produced).toHaveLength(12);
    expect(log.since(0)).toHaveLength(12);
    expect(log.rejectedCount()).toBe(0);
    expect(produced.filter(row => row.code === 'stages_omitted')).toHaveLength(1);
    expect(produced.at(-2)?.props.stage).toBe('saved');
    expect(produced.at(-1)?.props).toMatchObject({
      outcome: 'success',
      last_stage: 'saved',
      attempt_id: attempt,
      api_version: 6,
      omitted_stage_count: 53
    });
    expect(JSON.stringify(produced)).not.toMatch(/text|path|filename|model|visible/u);
  });
  it('has a different attempt on retry and cannot accept content as identity', () => {
    const produced: DiagnosticProps[] = [];
    new TranscriptionAttemptJournal(job, attempt, (_code, props) => produced.push(props)).terminal(
      'cancelled'
    );
    new TranscriptionAttemptJournal(job, '81000000-0000-4000-8000-000000000003', (_code, props) =>
      produced.push(props)
    ).terminal('failure', 'TRANSCRIBE_FAILED');
    expect(new Set(produced.map(row => row.attempt_id)).size).toBe(2);
    const legacy: DiagnosticProps[] = [];
    new TranscriptionAttemptJournal('private-file.mp4', attempt, (_code, props) =>
      legacy.push(props)
    );
    expect(legacy[0]).not.toHaveProperty('run_id');
    expect(JSON.stringify(legacy)).not.toContain('private-file');
  });
});

it('binds team transcription stages to the operation without collecting arbitrary source keys', () => {
  const operation = '81000000-0000-4000-8000-000000000004';
  const produced: DiagnosticProps[] = [];
  const run = transcriptionDiagnosticRunId(job, 'team:' + operation);
  new TranscriptionAttemptJournal(
    job,
    attempt,
    (_code, props) => produced.push(props),
    run
  ).terminal('cancelled');
  expect(produced[0]).toMatchObject({ flow_id: job, run_id: operation, attempt_id: attempt });
  expect(transcriptionDiagnosticRunId(job, 'team:/private/user/movie.mp4')).toBe(job);
});

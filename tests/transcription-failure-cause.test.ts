import { expect, it, vi } from 'vitest';
import {
  TranscriptionAttemptJournal,
  transcriptionFailureDetail
} from '../apps/agent/src/transcription/diagnostics';

/**
 * Production 2026-11-12 (Windows 1.4.3): every transcription failed two seconds in with only
 * TRANSCRIBE_FAILED in the journal. The cause — whisper-cli.exe could not load the Visual C++
 * runtime — was visible only as an exit code nobody recorded.
 */
const run = (code: number | null, stderr = '', spawnErrorCode: string | null = null) => ({
  code,
  stderr,
  spawnErrorCode
});

it('names the Windows exit codes a missing runtime or a CPU mismatch produce', () => {
  expect(transcriptionFailureDetail(run(0xc0000135))).toEqual({
    cause: 'runtime_library_missing',
    exitCode: 0xc0000135
  });
  expect(transcriptionFailureDetail(run(-1073741515)).cause).toBe('runtime_library_missing');
  expect(transcriptionFailureDetail(run(0xc0000139)).cause).toBe('runtime_library_missing');
  expect(transcriptionFailureDetail(run(0xc000001d)).cause).toBe('illegal_instruction');
  expect(transcriptionFailureDetail(run(0xc0000005)).cause).toBe('crashed');
  expect(transcriptionFailureDetail(run(0xc0000409)).cause).toBe('crashed');
});

it('reads only a class from stderr, never the text itself', () => {
  expect(transcriptionFailureDetail(run(1, 'ggml: failed to allocate 3.1 GB')).cause).toBe(
    'out_of_memory'
  );
  expect(
    transcriptionFailureDetail(run(1, 'whisper_init: failed to load model from C:\\x.bin')).cause
  ).toBe('model_load_failed');
  expect(transcriptionFailureDetail(run(1, 'No space left on device')).cause).toBe('disk_full');
  expect(transcriptionFailureDetail(run(1, 'WHISPER_OUTPUT_MISSING: ENOENT')).cause).toBe(
    'output_missing'
  );
  expect(transcriptionFailureDetail(run(1, 'SPEECH_NOT_TRANSCRIBED window=0')).cause).toBe(
    'speech_not_transcribed'
  );
  expect(transcriptionFailureDetail(run(1, 'something else')).cause).toBe('exit_nonzero');
  expect(transcriptionFailureDetail(run(null, '', 'ENOENT'))).toEqual({
    cause: 'tool_not_started',
    exitCode: null
  });
});

it('records the cause and exit code on a failed attempt, and nothing extra otherwise', () => {
  const emit = vi.fn();
  const attempt = '47000000-0000-4000-8000-000000000001';
  const failed = new TranscriptionAttemptJournal(attempt, attempt, emit);
  failed.terminal('failure', 'TRANSCRIBE_FAILED', transcriptionFailureDetail(run(0xc0000135)));
  expect(emit).toHaveBeenLastCalledWith(
    'terminal',
    expect.objectContaining({
      outcome: 'failure',
      error_code: 'TRANSCRIBE_FAILED',
      failure_cause: 'runtime_library_missing',
      exit_code: 0xc0000135
    })
  );
  const done = new TranscriptionAttemptJournal(attempt, attempt, emit);
  done.terminal('success', null, null);
  const props = emit.mock.calls.at(-1)![1];
  expect(props).not.toHaveProperty('failure_cause');
  expect(props).not.toHaveProperty('exit_code');
});

import { describe, expect, it, vi } from 'vitest';
import {
  COMPRESSION_ERROR_CODES,
  ESTIMATE_ERROR_CODES,
  LANDING_ERROR_CODES,
  STITCH_ERROR_CODES,
  TRANSCRIPTION_ERROR_CODES
} from '../packages/shared/src/types';
import {
  ERROR_STAGES_BY_TOOL,
  sanitizeAnalyticsProperties
} from '../apps/web/src/analytics/events';
import {
  errorFingerprint,
  landingErrorStage,
  landingFailureError,
  safeErrorCode,
  stitchErrorStage,
  stitchFailureError,
  teamOperationErrorStage,
  toolErrorProperties,
  trackToolError,
  transcriptionErrorStage,
  transcriptionFailureError,
  transcriptionTranslationErrors
} from '../apps/web/src/analytics/errors';
import {
  compressionErrorCode,
  compressionErrorStage,
  compressionFailureError,
  estimateErrorCode,
  estimateFailureError,
  jobTransitionEventNames
} from '../apps/web/src/analytics/compression';
import { toolJobActivityEvents } from '../apps/web/src/analytics/tools';
import { friendlyErrorCode, processingErrorCode } from '../apps/agent/src/queue/queue';
import { ImageAssetError } from '../apps/agent/src/images/store';
import { makeJob } from './helpers';

/**
 * 031 T010/T011 / FR-052 — `error_occurred` for every tool: a stage from the tool's closed
 * vocabulary, a stable code (the agent's where it gives one), `<tool>:<stage>:<code>` as the
 * fingerprint, and a correlation id — and never the text of an error.
 */

const RUN = '7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const PRIVATE = /Users|secret|\.mov|\/|\\/;

describe('safeErrorCode', () => {
  it('passes machine codes and turns everything else into unknown', () => {
    expect(safeErrorCode(new Error('CONNECTION_FAILED'))).toBe('CONNECTION_FAILED');
    expect(safeErrorCode({ code: 'NATIVE_PICKER_TIMEOUT', message: 'x' })).toBe(
      'NATIVE_PICKER_TIMEOUT'
    );
    expect(safeErrorCode('DISK_FULL')).toBe('DISK_FULL');
    expect(safeErrorCode(new Error('Could not open /Users/someone/secret.mov'))).toBe('unknown');
    expect(safeErrorCode('secret.mov')).toBe('unknown');
    expect(safeErrorCode('token=abc')).toBe('unknown');
    expect(safeErrorCode(null)).toBe('unknown');
    expect(safeErrorCode(undefined, 'STITCH_INPUT_FAILED')).toBe('STITCH_INPUT_FAILED');
  });
});

describe('toolErrorProperties', () => {
  it('builds the fingerprint from tool, stage and code and keeps the correlation ids', () => {
    expect(
      toolErrorProperties({ tool: 'transcription', stage: 'model', code: 'TIMEOUT', runId: RUN })
    ).toEqual({
      tool_identifier: 'transcription',
      run_id: RUN,
      error_stage: 'model',
      error_code: 'TIMEOUT',
      error_fingerprint: 'transcription:model:TIMEOUT',
      outcome: 'failure'
    });
  });

  it('describes a team error by its fingerprint, without a standalone tool identifier', () => {
    const properties = toolErrorProperties({
      tool: 'team',
      stage: 'process',
      code: 'DRIVE_UNAVAILABLE',
      flowId: RUN,
      workflowId: 'wf_01',
      retryable: true
    });
    expect(properties).not.toHaveProperty('tool_identifier');
    expect(properties).toMatchObject({
      flow_id: RUN,
      workflow_id: 'wf_01',
      error_fingerprint: 'team:process:DRIVE_UNAVAILABLE',
      retryable: true
    });
  });

  it('is accepted whole by the client sanitizer for every tool and stage', () => {
    for (const [tool, stages] of Object.entries(ERROR_STAGES_BY_TOOL)) {
      if (tool === 'readiness' || tool === 'link') continue;
      for (const stage of stages) {
        const properties = toolErrorProperties({
          tool: tool as 'team',
          stage: stage as 'process',
          code: 'IMAGE_FILTER_GRAPH_INVALID',
          runId: RUN
        });
        expect(sanitizeAnalyticsProperties(properties, 'error_occurred')).toEqual(properties);
      }
    }
  });

  it('never carries the message of the error it was given', () => {
    const tracker = { track: vi.fn() };
    trackToolError(
      {
        tool: 'landing-optimizer',
        stage: 'upload',
        code: new Error('Upload of /Users/someone/secret.mov failed'),
        flowId: RUN
      },
      tracker
    );
    const [[name, properties]] = tracker.track.mock.calls;
    expect(name).toBe('error_occurred');
    expect(properties).toMatchObject({
      error_code: 'unknown',
      error_fingerprint: 'landing-optimizer:upload:unknown'
    });
    expect(JSON.stringify(properties)).not.toMatch(PRIVATE);
  });
});

describe('compressor', () => {
  it('reads the agent code, maps it to a compressor stage, and falls back to unknown', () => {
    const failed = makeJob(RUN, 'failed', {
      error: 'There is not enough free disk space.',
      errorCode: 'DISK_FULL'
    });
    expect(compressionErrorCode(failed)).toBe('DISK_FULL');
    expect(compressionFailureError(failed)).toMatchObject({
      tool_identifier: 'compressor',
      run_id: RUN,
      error_stage: 'output',
      error_code: 'DISK_FULL',
      error_fingerprint: 'compressor:output:DISK_FULL'
    });
    // An agent older than the field: the sentence is never read for a code.
    const legacy = makeJob(RUN, 'failed', { error: 'The source file is no longer available.' });
    expect(compressionErrorCode(legacy)).toBe('unknown');
    expect(compressionFailureError(legacy)).toMatchObject({
      error_stage: 'encode',
      error_fingerprint: 'compressor:encode:unknown'
    });
  });

  it('places every agent compression code in a compressor stage', () => {
    const stages = ERROR_STAGES_BY_TOOL.compressor as readonly string[];
    for (const code of COMPRESSION_ERROR_CODES) {
      expect(stages).toContain(compressionErrorStage(code));
      expect(errorFingerprint('compressor', compressionErrorStage(code), code).length).toBeLessThan(
        96
      );
    }
    expect(compressionErrorStage('IMAGE_DAMAGED')).toBe('image_embedding');
    expect(compressionErrorStage('UNSUPPORTED_MEDIA')).toBe('input');
    expect(compressionErrorStage('FFMPEG_FAILED')).toBe('encode');
  });

  it('turns an estimate that became unavailable into estimate_failed with a safe code', () => {
    const estimating = makeJob(RUN, 'ready', { estimateStatus: 'estimating' });
    const failed = makeJob(RUN, 'ready', {
      estimateStatus: 'unavailable',
      estimateError: 'ffprobe exited with /Users/someone/secret.mov'
    });
    expect(jobTransitionEventNames(estimating, failed)).toEqual(['estimate_failed']);
    expect(jobTransitionEventNames(failed, failed)).toEqual([]);
    expect(estimateErrorCode(failed)).toBe('unknown');
    expect(estimateFailureError(failed)).toMatchObject({
      run_id: RUN,
      error_stage: 'estimate',
      error_fingerprint: 'compressor:estimate:unknown'
    });
  });
});

describe('agent compression codes (T011)', () => {
  it('names each FFmpeg failure the way the sentence beside it does', () => {
    expect(friendlyErrorCode('write failed: No space left on device')).toBe('DISK_FULL');
    expect(friendlyErrorCode('Permission denied')).toBe('DESTINATION_NOT_WRITABLE');
    expect(friendlyErrorCode('Invalid data found when processing input')).toBe('UNSUPPORTED_MEDIA');
    expect(friendlyErrorCode('Failed to configure output pad')).toBe('IMAGE_ADAPT_FAILED');
    expect(friendlyErrorCode('Error initializing complex filters')).toBe(
      'IMAGE_FILTER_GRAPH_INVALID'
    );
    expect(friendlyErrorCode('something else')).toBe('FFMPEG_FAILED');
  });

  it('names each processing failure from its typed error, never from free text', () => {
    expect(processingErrorCode(new ImageAssetError('IMAGE_DAMAGED'))).toBe('IMAGE_DAMAGED');
    expect(processingErrorCode(new ImageAssetError('IMAGE_UNAVAILABLE'))).toBe('IMAGE_UNAVAILABLE');
    expect(processingErrorCode(new Error('IMAGE_FILTER_GRAPH_INVALID: x'))).toBe(
      'IMAGE_FILTER_GRAPH_INVALID'
    );
    expect(processingErrorCode(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(
      'SOURCE_NOT_FOUND'
    );
    expect(processingErrorCode(new Error('anything'))).toBe('PROCESSING_FAILED');
    for (const code of [
      friendlyErrorCode(''),
      processingErrorCode(null),
      processingErrorCode(new ImageAssetError('IMAGE_DAMAGED'))
    ]) {
      expect(COMPRESSION_ERROR_CODES).toContain(code);
    }
  });
});

describe('queue lifecycles', () => {
  const lifecycle = {
    started: ['processing'],
    completed: ['completed'],
    failed: ['failed'],
    cancelled: ['cancelled']
  };

  it('adds error_occurred after operation_failed, on the job id', () => {
    const events = toolJobActivityEvents(
      'transcription',
      [{ id: RUN, status: 'processing', error: null }],
      [{ id: RUN, status: 'failed', error: 'WHISPER_EXIT_FAILED' }],
      lifecycle,
      (job, runId) =>
        toolErrorProperties({
          tool: 'transcription',
          stage: 'transcribe',
          code: job.error,
          ...(runId ? { runId } : {})
        })
    );
    expect(events.map(event => event.name)).toEqual(['operation_failed', 'error_occurred']);
    expect(events[1]!.properties).toMatchObject({
      run_id: RUN,
      error_fingerprint: 'transcription:transcribe:WHISPER_EXIT_FAILED'
    });
  });

  it('drops a job id that is not an agent UUID instead of sending it', () => {
    const events = toolJobActivityEvents(
      'landing-optimizer',
      [{ id: 'secret-landing.zip', status: 'processing', error: null }],
      [{ id: 'secret-landing.zip', status: 'failed', error: null }],
      lifecycle,
      (job, runId) =>
        toolErrorProperties({
          tool: 'landing-optimizer',
          stage: 'optimize',
          code: job.error,
          ...(runId ? { runId } : {})
        })
    );
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(events[1]!.properties).toMatchObject({ error_code: 'unknown' });
  });
});

describe('team', () => {
  it('maps every team operation kind to a team stage', () => {
    const stages = ERROR_STAGES_BY_TOOL.team as readonly string[];
    for (const kind of [
      'upload',
      'download',
      'rename',
      'move',
      'trash',
      'restore',
      'content_edit',
      'new_version',
      'process',
      'folder_create'
    ]) {
      expect(stages).toContain(teamOperationErrorStage(kind));
    }
    expect(teamOperationErrorStage('process')).toBe('process');
    expect(teamOperationErrorStage('download')).toBe('download');
    expect(teamOperationErrorStage('upload')).toBe('transfer');
  });
});

describe('agent codes for every tool (033 T006)', () => {
  const lifecycle = {
    started: ['processing', 'running'],
    completed: ['completed', 'done'],
    failed: ['failed', 'interrupted'],
    cancelled: ['cancelled']
  };

  it('carries the transcription code to error_occurred with its stage, never the sentence', () => {
    const events = toolJobActivityEvents(
      'transcription',
      [{ id: RUN, status: 'processing' as const, errorCode: null }],
      [
        {
          id: RUN,
          status: 'failed' as const,
          error: 'The speech model for this run is not installed.',
          errorCode: 'MODEL_MISSING' as const
        }
      ],
      lifecycle,
      (job, runId) => transcriptionFailureError(job, runId)
    );
    expect(events.map(event => event.name)).toEqual(['operation_failed', 'error_occurred']);
    expect(events[1]!.properties).toMatchObject({
      run_id: RUN,
      error_stage: 'model',
      error_code: 'MODEL_MISSING',
      error_fingerprint: 'transcription:model:MODEL_MISSING'
    });
    // An agent older than the field: the sentence is never read; an interruption still is a status.
    expect(transcriptionFailureError({ status: 'failed' }, RUN)).toMatchObject({
      error_fingerprint: 'transcription:transcribe:unknown'
    });
    expect(transcriptionFailureError({ status: 'interrupted' }, RUN)).toMatchObject({
      error_fingerprint: 'transcription:transcribe:INTERRUPTED'
    });
  });

  it('reports a failed translation once, and never a cancelled one', () => {
    const translation = (status: 'processing' | 'failed', error: string | null) => ({
      targetLanguage: 'uk',
      status,
      progress: null,
      completedSegments: 0,
      totalSegments: 0,
      error: error as 'TRANSLATION_FAILED' | null
    });
    const before = [{ id: RUN, translation: translation('processing', null) }];
    const failed = [{ id: RUN, translation: translation('failed', 'TRANSLATION_FAILED') }];
    expect(transcriptionTranslationErrors(before, failed, () => RUN)).toEqual([
      expect.objectContaining({
        run_id: RUN,
        error_stage: 'translate',
        error_fingerprint: 'transcription:translate:TRANSLATION_FAILED'
      })
    ]);
    expect(transcriptionTranslationErrors(failed, failed)).toEqual([]);
    expect(transcriptionTranslationErrors(null, failed)).toEqual([]);
    const cancelled = [{ id: RUN, translation: translation('failed', 'TRANSLATION_CANCELLED') }];
    expect(transcriptionTranslationErrors(before, cancelled)).toEqual([]);
  });

  it('carries the stitcher code to error_occurred with its stage', () => {
    const events = toolJobActivityEvents(
      'stitcher',
      [{ id: RUN, status: 'running', error: null }],
      [
        {
          id: RUN,
          status: 'failed',
          error: 'STITCH_OUTPUT_UNWRITABLE',
          errorCode: 'STITCH_OUTPUT_UNWRITABLE' as const
        }
      ],
      lifecycle,
      (job, runId) => stitchFailureError(job, runId)
    );
    expect(events[1]!.properties).toMatchObject({
      tool_identifier: 'stitcher',
      run_id: RUN,
      error_stage: 'output',
      error_fingerprint: 'stitcher:output:STITCH_OUTPUT_UNWRITABLE'
    });
    // An older agent's `error` is taken only when it normalises into the closed list.
    expect(stitchFailureError({ error: 'STITCH_PLAN_VIDEO-CODEC' })).toMatchObject({
      error_fingerprint: 'stitcher:input_probe:STITCH_PLAN_VIDEO_CODEC'
    });
    expect(
      stitchFailureError({ error: 'Could not write /Users/someone/secret.mov' })
    ).toMatchObject({ error_fingerprint: 'stitcher:stitch:unknown' });
  });

  it('carries the landing optimizer code to error_occurred with its stage', () => {
    const events = toolJobActivityEvents(
      'landing-optimizer',
      [{ id: RUN, status: 'processing', error: null }],
      [{ id: RUN, status: 'failed', error: 'ENOSPC: /x', errorCode: 'DISK_FULL' as const }],
      lifecycle,
      (job, runId) => landingFailureError(job, runId)
    );
    expect(events[1]!.properties).toMatchObject({
      tool_identifier: 'landing-optimizer',
      run_id: RUN,
      error_stage: 'package',
      error_code: 'DISK_FULL',
      error_fingerprint: 'landing-optimizer:package:DISK_FULL'
    });
    expect(JSON.stringify(events)).not.toMatch(PRIVATE);
    expect(landingFailureError({ error: 'The landing could not be optimized.' })).toMatchObject({
      error_fingerprint: 'landing-optimizer:optimize:unknown'
    });
  });

  it('carries the estimate code to estimate_failed and error_occurred', () => {
    const failed = makeJob(RUN, 'ready', {
      estimateStatus: 'unavailable',
      estimateError: 'Too few representative samples could be read.',
      estimateErrorCode: 'ESTIMATE_SAMPLES_UNREADABLE'
    });
    expect(estimateErrorCode(failed)).toBe('ESTIMATE_SAMPLES_UNREADABLE');
    expect(estimateFailureError(failed)).toMatchObject({
      run_id: RUN,
      error_stage: 'estimate',
      error_code: 'ESTIMATE_SAMPLES_UNREADABLE',
      error_fingerprint: 'compressor:estimate:ESTIMATE_SAMPLES_UNREADABLE'
    });
  });

  it('places every agent code of every tool in one of its tool stages', () => {
    const cases: [readonly string[], readonly string[], (code: string) => string, string][] = [
      [
        TRANSCRIPTION_ERROR_CODES,
        ERROR_STAGES_BY_TOOL.transcription,
        transcriptionErrorStage,
        'transcription'
      ],
      [STITCH_ERROR_CODES, ERROR_STAGES_BY_TOOL.stitcher, stitchErrorStage, 'stitcher'],
      [
        LANDING_ERROR_CODES,
        ERROR_STAGES_BY_TOOL['landing-optimizer'],
        landingErrorStage,
        'landing-optimizer'
      ],
      [ESTIMATE_ERROR_CODES, ERROR_STAGES_BY_TOOL.compressor, () => 'estimate', 'compressor']
    ];
    for (const [codes, stages, stageOf, tool] of cases) {
      for (const code of codes) {
        expect(safeErrorCode(code)).toBe(code);
        expect(stages, `${tool}:${code}`).toContain(stageOf(code));
        expect(errorFingerprint(tool as 'stitcher', stageOf(code), code).length).toBeLessThan(96);
      }
    }
    expect(transcriptionErrorStage('AUDIO_EXTRACT_FAILED')).toBe('input');
    expect(transcriptionErrorStage('DOCUMENT_WRITE_FAILED')).toBe('save');
    expect(stitchErrorStage('STITCH_PLAN_NO_SCREENS')).toBe('input_probe');
    expect(stitchErrorStage('BODY_JOIN_FAILED')).toBe('stitch');
    expect(landingErrorStage('LANDING_WORKSPACE_LOST')).toBe('upload');
  });
});

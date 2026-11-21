import { describe, expect, it, vi } from 'vitest';
import {
  callStructured,
  ClaudeTransportError,
  costMicroUsd,
  type ClaudeClient,
  type ClaudeRequest,
  type UsageRecord
} from '../supabase/functions/_shared/claude.ts';
import { allowanceExceeded } from '../supabase/functions/_shared/ai-allowance.ts';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.ts';
import {
  parseTranslateCommand,
  startTranslation,
  watchTranslation,
  type TranslateDeps
} from '../supabase/functions/transcript-translate/handler.ts';
import {
  systemPrompt,
  translateTranscript
} from '../supabase/functions/transcript-translate/translate.ts';
import { createFakeClient } from '../supabase/functions/transcript-translate/fake-provider.ts';

/**
 * 063: the function with the model and the database replaced by recording fakes. What must hold:
 * the same text is never paid for twice; the allowance error carries the numbers a person needs;
 * a refusal is retried once on the stronger model and then given back; a malformed answer is
 * retried once; `watch` streams progress and ends with the result.
 */

const USER = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-0000000000aa';
const VIDEO = '00000000-0000-4000-8000-0000000000bb';
const TRANSLATION = '00000000-0000-4000-8000-0000000000cc';
const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };

function linesOf(request: ClaudeRequest): string[] {
  const range = /Translate lines (\d+)–(\d+)/u.exec(request.user)!;
  const all = [...request.user.matchAll(/^(\d+)\. (.*)$/gmu)];
  return all
    .filter(match => Number(match[1]) >= Number(range[1]) && Number(match[1]) <= Number(range[2]))
    .map(match => `UK ${match[2]}`);
}

function scripted(
  replies: Array<(request: ClaudeRequest) => { stopReason: string; text: string | null }>
): ClaudeClient & { calls: ClaudeRequest[] } {
  const calls: ClaudeRequest[] = [];
  return {
    calls,
    async create(request) {
      calls.push(request);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return { ...reply(request), usage };
    }
  };
}

const good = (request: ClaudeRequest) => ({
  stopReason: 'end_turn',
  text: JSON.stringify({ translations: linesOf(request) })
});

describe('callStructured', () => {
  it('records every attempt, including a refusal, with its cost', async () => {
    const record = vi.fn<(entry: UsageRecord) => void>();
    const client = scripted([() => ({ stopReason: 'refusal', text: null })]);
    const outcome = await callStructured(
      client,
      {
        model: 'claude-haiku-5-5',
        effort: 'high',
        system: 's',
        user: 'u',
        schema: {},
        maxTokens: 10
      },
      { signal: new AbortController().signal, record }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('refused');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }));
  });

  it('maps a transport failure to unavailable without a cost', async () => {
    const record = vi.fn();
    const client: ClaudeClient = {
      create: () => Promise.reject(new ClaudeTransportError(529))
    };
    const outcome = await callStructured(
      client,
      {
        model: 'claude-haiku-5-5',
        effort: 'high',
        system: 's',
        user: 'u',
        schema: {},
        maxTokens: 10
      },
      { signal: new AbortController().signal, record }
    );
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'unavailable',
      httpStatus: 529,
      costMicroUsd: 0
    });
  });

  it('prices Haiku 5.5 at $0.10 / $0.50 per million tokens, rounding up', () => {
    expect(costMicroUsd('claude-haiku-5-5', usage)).toBe(200);
    expect(costMicroUsd('claude-sonnet-5-5', usage)).toBe(4000);
    expect(
      costMicroUsd('claude-haiku-5-5', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
    ).toBe(1);
  });
});

describe('translateTranscript', () => {
  const segments = ['Merhaba.', 'Bir tablet al.', '', 'Teşekkürler.'];
  const base = {
    sourceLanguage: 'tr',
    targetLanguage: 'uk',
    record: async () => {},
    onProgress: async () => {}
  };

  it('describes the job truthfully and asks for exactly the requested lines', () => {
    expect(systemPrompt('es-MX')).toContain('for reading and review, not for publishing');
    expect(systemPrompt('es-MX')).toContain('(es-MX)');
    // Measured 2026-11-21: "Canan Karatay" became "Yanán Karatái" in Spanish under a
    // pronounce-everything rule, and "Канан" in Ukrainian without one.
    expect(systemPrompt('uk')).toMatch(/same script.*another script, transliterate/su);
  });

  it('translates every chunk and keeps empty segments empty', async () => {
    const client = scripted([good]);
    const progress: number[] = [];
    const result = await translateTranscript({
      ...base,
      client,
      segments,
      chunkUnits: 12,
      onProgress: async completed => void progress.push(completed)
    });
    expect(result).toEqual({
      ok: true,
      model: 'claude-haiku-5-5',
      segments: ['UK Merhaba.', 'UK Bir tablet al.', '', 'UK Teşekkürler.']
    });
    expect(client.calls.every(call => call.user.includes('4. Teşekkürler.'))).toBe(true);
    expect(Math.max(...progress)).toBe(4);
  });

  it('retries a wrong line count once, then fails', async () => {
    const wrong = () => ({ stopReason: 'end_turn', text: JSON.stringify({ translations: ['x'] }) });
    const fixed = await translateTranscript({
      ...base,
      client: scripted([wrong, good]),
      segments: ['a', 'b']
    });
    expect(fixed.ok).toBe(true);
    const failed = await translateTranscript({
      ...base,
      client: scripted([wrong]),
      segments: ['a', 'b']
    });
    expect(failed).toEqual({ ok: false, code: 'TRANSLATION_FAILED' });
  });

  it('escalates one refusal to Sonnet 5.5 and reports the model that answered', async () => {
    const client = scripted([() => ({ stopReason: 'refusal', text: null }), good]);
    const result = await translateTranscript({ ...base, client, segments: ['a'] });
    expect(result).toMatchObject({ ok: true, model: 'claude-sonnet-5-5' });
    expect(client.calls.map(call => call.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  it('gives up after the stronger model declines too', async () => {
    const client = scripted([() => ({ stopReason: 'refusal', text: null })]);
    expect(await translateTranscript({ ...base, client, segments: ['a'] })).toEqual({
      ok: false,
      code: 'TRANSLATION_REFUSED'
    });
  });

  it('runs against the beta stand-in', async () => {
    const result = await translateTranscript({
      ...base,
      client: createFakeClient('fake', 1),
      segments: ['Merhaba.']
    });
    expect(result).toMatchObject({ ok: true, segments: ['[uk] Merhaba.'] });
    expect(
      await translateTranscript({
        ...base,
        client: createFakeClient('fake-down', 1),
        segments: ['a']
      })
    ).toEqual({ ok: false, code: 'TRANSLATION_UNAVAILABLE' });
  });
});

describe('parseTranslateCommand', () => {
  it('accepts the two scopes and rejects anything else', () => {
    expect(
      parseTranslateCommand({
        action: 'start',
        targetLanguage: 'es-MX',
        source: { scope: 'team_video', teamId: TEAM, videoId: VIDEO }
      })
    ).toMatchObject({ action: 'start', targetLanguage: 'es-MX' });
    expect(() =>
      parseTranslateCommand({
        action: 'start',
        targetLanguage: 'xx',
        source: { scope: 'team_video', teamId: TEAM, videoId: VIDEO }
      })
    ).toThrow(TeamFunctionError);
    expect(() =>
      parseTranslateCommand({
        action: 'start',
        targetLanguage: 'uk',
        source: { scope: 'personal', documentKey: '../x', sourceLanguage: null, segments: ['a'] }
      })
    ).toThrow(TeamFunctionError);
  });
});

function deps(overrides: Partial<TranslateDeps> & { begin?: unknown; beginError?: unknown } = {}) {
  const service = vi.fn(async (name: string, _parameters: Record<string, unknown>) => {
    if (name === 'service_transcript_translation_begin') {
      return overrides.beginError
        ? { data: null, error: overrides.beginError as { message: string } }
        : {
            data: overrides.begin ?? { id: TRANSLATION, status: 'processing', reused: false },
            error: null
          };
    }
    return { data: null, error: null };
  });
  const caller = vi.fn(async (name: string, _parameters: Record<string, unknown>) => {
    if (name === 'list_video_text_variants') {
      return {
        data: {
          sourceVersion: 'v',
          canProcess: true,
          variants: [
            {
              kind: 'original',
              language: 'tr',
              ingestState: 'full',
              truncated: false,
              text: 'Merhaba.\nBir tablet al.'
            }
          ]
        },
        error: null
      };
    }
    if (name === 'ai_allowance_status') {
      return {
        data: {
          feature: 'transcript_translation',
          limitUnits: 9000,
          usedUnits: 8990,
          day: '2026-11-21',
          resetsAt: '2026-11-21T22:00:00Z'
        },
        error: null
      };
    }
    return { data: null, error: null };
  });
  const background = vi.fn<(work: Promise<void>) => void>();
  return {
    service,
    caller,
    background,
    deps: {
      userId: USER,
      callerRpc: caller,
      serviceRpc: service,
      client: scripted([good]),
      background,
      ...overrides
    } satisfies TranslateDeps
  };
}

const start = {
  action: 'start' as const,
  targetLanguage: 'uk',
  source: { scope: 'team_video' as const, teamId: TEAM, videoId: VIDEO }
};

describe('startTranslation', () => {
  it('reads the space text with the caller rights and reserves what it costs', async () => {
    const harness = deps();
    const result = await startTranslation(start, harness.deps);
    expect(result).toMatchObject({ translationId: TRANSLATION, reused: false, units: 23 });
    const begin = harness.service.mock.calls.find(
      call => call[0] === 'service_transcript_translation_begin'
    )!;
    expect(begin[1]).toMatchObject({ p_units: 23, p_total_segments: 2, p_source_language: 'tr' });
    expect(harness.caller).toHaveBeenCalledWith('list_video_text_variants', {
      p_team: TEAM,
      p_video: VIDEO
    });
    expect(harness.background).toHaveBeenCalledTimes(1);
  });

  it('does not run the model for a translation that already exists', async () => {
    const harness = deps({ begin: { id: TRANSLATION, status: 'completed', reused: true } });
    const result = await startTranslation(start, harness.deps);
    expect(result).toMatchObject({ status: 'completed', reused: true });
    expect(harness.background).not.toHaveBeenCalled();
  });

  it('refuses to translate into the source language', async () => {
    const harness = deps();
    await expect(
      startTranslation({ ...start, targetLanguage: 'tr' }, harness.deps)
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
  });

  it('reserves nothing without a model', async () => {
    const harness = deps({ client: null });
    await expect(startTranslation(start, harness.deps)).rejects.toMatchObject({
      code: 'TRANSLATION_UNAVAILABLE'
    });
    expect(harness.service).not.toHaveBeenCalled();
  });

  it('turns the database limit into numbers a person can read', async () => {
    const harness = deps({
      beginError: {
        message: 'ALLOWANCE_EXCEEDED',
        details: JSON.stringify({ neededUnits: 23, usedUnits: 8990, limitUnits: 9000 })
      }
    });
    await expect(startTranslation(start, harness.deps)).rejects.toMatchObject({
      code: 'TRANSLATION_ALLOWANCE_EXCEEDED',
      details: {
        neededUnits: 23,
        usedUnits: 8990,
        limitUnits: 9000,
        resetsAt: '2026-11-21T22:00:00Z'
      }
    });
  });

  it('completes in the background, or fails and gives the allowance back', async () => {
    const harness = deps();
    await startTranslation(start, harness.deps);
    await harness.background.mock.calls[0]![0];
    expect(harness.service).toHaveBeenCalledWith('service_transcript_translation_complete', {
      p_id: TRANSLATION,
      p_segments: ['UK Merhaba.', 'UK Bir tablet al.'],
      p_model: 'claude-haiku-5-5'
    });
    const refusing = deps({ client: scripted([() => ({ stopReason: 'refusal', text: null })]) });
    await startTranslation(start, refusing.deps);
    await refusing.background.mock.calls[0]![0];
    expect(refusing.service).toHaveBeenCalledWith('service_transcript_translation_fail', {
      p_id: TRANSLATION,
      p_code: 'TRANSLATION_REFUSED'
    });
    expect(
      refusing.service.mock.calls.filter(call => call[0] === 'service_ai_usage_record')
    ).toHaveLength(2);
  });
});

describe('watchTranslation', () => {
  it('streams progress until the result arrives', async () => {
    const states = [
      { status: 'processing', completedSegments: 0 },
      { status: 'processing', completedSegments: 1 },
      { status: 'completed', completedSegments: 2 }
    ];
    let read = 0;
    const caller = vi.fn(async () => {
      const state = states[Math.min(read++, states.length - 1)]!;
      return {
        data: {
          id: TRANSLATION,
          scope: 'team_video',
          targetLanguage: 'uk',
          sourceLanguage: 'tr',
          sourceFingerprint: `v1:${'b'.repeat(64)}`,
          status: state.status,
          failureCode: null,
          segments: state.status === 'completed' ? ['a', 'b'] : null,
          totalSegments: 2,
          completedSegments: state.completedSegments,
          units: 3,
          model: state.status === 'completed' ? 'claude-haiku-5-5' : null,
          createdAt: '2026-11-21T10:00:00Z',
          completedAt: state.status === 'completed' ? '2026-11-21T10:00:05Z' : null
        },
        error: null
      };
    });
    const harness = deps({ callerRpc: caller, sleep: async () => {} });
    const stream = await watchTranslation(
      { action: 'watch', translationId: TRANSLATION },
      harness.deps
    );
    const text = await new Response(stream).text();
    const events = text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual(['progress', 'progress', 'done']);
    expect(events[1].completedSegments).toBe(1);
    expect(events[2].translation.segments).toEqual(['a', 'b']);
  });

  it('answers a foreign id as not found before any stream opens', async () => {
    const caller = vi.fn(async () => ({ data: null, error: { message: 'NOT_FOUND' } }));
    const harness = deps({ callerRpc: caller });
    await expect(
      watchTranslation({ action: 'watch', translationId: TRANSLATION }, harness.deps)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('allowanceExceeded', () => {
  it('only recognises the allowance error', () => {
    expect(allowanceExceeded({ message: 'PERMISSION_DENIED' })).toBeNull();
    expect(allowanceExceeded({ message: 'ALLOWANCE_EXCEEDED', details: 'nope' })?.limitUnits).toBe(
      0
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  CRF_MAX,
  CRF_MIN,
  FRAME_RATE_MAX,
  FRAME_RATE_MIN,
  MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  MAX_CUSTOM_START_IMAGE_DURATION_MS,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  VIDEO_BITRATE_MAX_KBPS,
  VIDEO_BITRATE_MIN_KBPS,
  defaultImageEmbeddingSettings,
  type AgentSettingsPatch
} from '../packages/shared/src/types.js';
import { parseSettingsPatch } from '../apps/agent/src/compressor/settings-validation.js';

function parse(body: AgentSettingsPatch | null | undefined) {
  return parseSettingsPatch(body, defaultImageEmbeddingSettings());
}

function expectRejected(body: AgentSettingsPatch | null | undefined, error: string) {
  expect(parse(body)).toEqual({ ok: false, error });
}

describe('parseSettingsPatch', () => {
  it('rejects a missing or non-object body', () => {
    expectRejected(null, 'Invalid settings.');
    expectRejected(undefined, 'Invalid settings.');
  });

  it('validates the compression, output and rate-control modes', () => {
    expectRejected({ mode: 'turbo' } as unknown as AgentSettingsPatch, 'Invalid compression mode.');
    expectRejected(
      { outputMode: 'elsewhere' } as unknown as AgentSettingsPatch,
      'Invalid output mode.'
    );
    expectRejected(
      { rateControl: 'vbr' } as unknown as AgentSettingsPatch,
      'Invalid rate control.'
    );
    expectRejected(
      { stripMetadata: 'yes' } as unknown as AgentSettingsPatch,
      'Invalid metadata setting.'
    );
    const parsed = parse({ mode: 'custom', outputMode: 'chosen-folder', rateControl: 'bitrate' });
    expect(parsed).toEqual({
      ok: true,
      patch: { mode: 'custom', outputMode: 'chosen-folder', rateControl: 'bitrate' }
    });
  });

  it('accepts frame rates only inside the shared bounds, or null to unset', () => {
    expect(parse({ frameRate: null })).toEqual({ ok: true, patch: { frameRate: null } });
    expect(parse({ frameRate: FRAME_RATE_MIN })).toEqual({
      ok: true,
      patch: { frameRate: FRAME_RATE_MIN }
    });
    expect(parse({ frameRate: FRAME_RATE_MAX })).toEqual({
      ok: true,
      patch: { frameRate: FRAME_RATE_MAX }
    });
    expectRejected({ frameRate: FRAME_RATE_MIN - 1 }, 'Invalid frame rate.');
    expectRejected({ frameRate: FRAME_RATE_MAX + 1 }, 'Invalid frame rate.');
    expectRejected({ frameRate: 29.97 }, 'Invalid frame rate.');
  });

  it('accepts resolutions only inside the shared bounds, or null to unset', () => {
    expect(parse({ resolutionLimit: null })).toEqual({
      ok: true,
      patch: { resolutionLimit: null }
    });
    expect(parse({ resolutionLimit: RESOLUTION_MIN })).toEqual({
      ok: true,
      patch: { resolutionLimit: RESOLUTION_MIN }
    });
    expectRejected({ resolutionLimit: RESOLUTION_MIN - 1 }, 'Invalid resolution.');
    expectRejected({ resolutionLimit: RESOLUTION_MAX + 1 }, 'Invalid resolution.');
  });

  it('accepts CRF only inside the shared bounds', () => {
    expect(parse({ crf: CRF_MIN })).toEqual({ ok: true, patch: { crf: CRF_MIN } });
    expect(parse({ crf: CRF_MAX })).toEqual({ ok: true, patch: { crf: CRF_MAX } });
    expectRejected({ crf: CRF_MIN - 1 }, 'Invalid quality.');
    expectRejected({ crf: CRF_MAX + 1 }, 'Invalid quality.');
    expectRejected({ crf: 20.5 }, 'Invalid quality.');
  });

  it('accepts bitrates only inside the shared bounds', () => {
    expect(parse({ videoBitrateKbps: VIDEO_BITRATE_MIN_KBPS })).toEqual({
      ok: true,
      patch: { videoBitrateKbps: VIDEO_BITRATE_MIN_KBPS }
    });
    expectRejected({ videoBitrateKbps: VIDEO_BITRATE_MIN_KBPS - 1 }, 'Invalid bitrate.');
    expectRejected({ videoBitrateKbps: VIDEO_BITRATE_MAX_KBPS + 1 }, 'Invalid bitrate.');
  });

  it('refuses image assets smuggled through the settings patch', () => {
    expectRejected(
      { imageEmbedding: { startImages: [] } } as unknown as AgentSettingsPatch,
      'Image assets must be selected through the image API.'
    );
    expectRejected(
      { imageEmbedding: { endImage: null } } as unknown as AgentSettingsPatch,
      'Image assets must be selected through the image API.'
    );
    expectRejected(
      { imageEmbedding: null } as unknown as AgentSettingsPatch,
      'Invalid image embedding settings.'
    );
  });

  it('validates image embedding duration bounds', () => {
    expectRejected(
      { imageEmbedding: { customFinalDurationSeconds: 0 } },
      'INVALID_CUSTOM_IMAGE_DURATION'
    );
    expectRejected(
      {
        imageEmbedding: { customFinalDurationSeconds: MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS + 1 }
      },
      'INVALID_CUSTOM_IMAGE_DURATION'
    );
    expectRejected(
      { imageEmbedding: { customStartDurationMs: 0 } },
      'INVALID_CUSTOM_START_IMAGE_DURATION'
    );
    expectRejected(
      { imageEmbedding: { customStartDurationMs: MAX_CUSTOM_START_IMAGE_DURATION_MS + 1 } },
      'INVALID_CUSTOM_START_IMAGE_DURATION'
    );
    expectRejected(
      { imageEmbedding: { finalDurationMode: 'random-0-1' } } as unknown as AgentSettingsPatch,
      'Invalid final image duration mode.'
    );
    expectRejected(
      { imageEmbedding: { startDurationMode: 'forever' } } as unknown as AgentSettingsPatch,
      'Invalid start image duration mode.'
    );
    expectRejected(
      { imageEmbedding: { fitMode: 'zoom' } } as unknown as AgentSettingsPatch,
      'Invalid image fit mode.'
    );
  });

  it('merges a valid image embedding patch over the current settings', () => {
    const current = { ...defaultImageEmbeddingSettings(), customStartDurationMs: 250 };
    const parsed = parseSettingsPatch(
      { imageEmbedding: { enabled: true, startDurationMode: 'custom' } },
      current
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.patch.imageEmbedding).toMatchObject({
        enabled: true,
        startDurationMode: 'custom',
        customStartDurationMs: 250,
        fitMode: current.fitMode
      });
    }
  });
});

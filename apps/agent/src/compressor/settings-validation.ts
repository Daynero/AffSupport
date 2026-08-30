import {
  CRF_MAX,
  CRF_MIN,
  FRAME_RATE_MAX,
  FRAME_RATE_MIN,
  MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  MAX_CUSTOM_START_IMAGE_DURATION_MS,
  MIN_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  MIN_CUSTOM_START_IMAGE_DURATION_MS,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  VIDEO_BITRATE_MAX_KBPS,
  VIDEO_BITRATE_MIN_KBPS,
  type AgentSettings,
  type AgentSettingsPatch,
  type ImageEmbeddingSettings
} from '@video-compressor/shared';

export type SettingsPatchResult =
  { ok: true; patch: Partial<AgentSettings> } | { ok: false; error: string };

/**
 * Validates a `/api/settings` request body into a queue-ready settings patch.
 *
 * Every rejection here answers HTTP 400 with the exact error strings the web
 * client already relies on. Note that `JobQueue.updateSettings` would clamp
 * out-of-range frameRate/crf/videoBitrateKbps/resolutionLimit values anyway
 * (queue/queue.ts, clamp* helpers) — the route deliberately keeps rejecting
 * them instead, so a client bug surfaces as an error rather than a silently
 * corrected value.
 */
export function parseSettingsPatch(
  body: AgentSettingsPatch | null | undefined,
  currentImageEmbedding: ImageEmbeddingSettings
): SettingsPatchResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid settings.' };
  }
  const allowed: Partial<AgentSettings> = {};
  if (body.mode !== undefined) {
    if (!['optimal', 'custom'].includes(body.mode)) {
      return { ok: false, error: 'Invalid compression mode.' };
    }
    allowed.mode = body.mode;
  }
  if (body.outputMode !== undefined) {
    if (!['next-to-originals', 'chosen-folder'].includes(body.outputMode)) {
      return { ok: false, error: 'Invalid output mode.' };
    }
    allowed.outputMode = body.outputMode;
  }
  if (body.outputSuffix !== undefined) {
    if (body.outputSuffix !== null && typeof body.outputSuffix !== 'string') {
      return { ok: false, error: 'Invalid output suffix.' };
    }
    const trimmed = body.outputSuffix === null ? null : body.outputSuffix.trim();
    if (trimmed !== null && (trimmed.length > 60 || /[\/\\\u0000\r\n]/u.test(trimmed))) {
      return { ok: false, error: 'Invalid output suffix.' };
    }
    allowed.outputSuffix = trimmed === '' ? null : trimmed;
  }
  if (body.stripMetadata !== undefined) {
    if (typeof body.stripMetadata !== 'boolean') {
      return { ok: false, error: 'Invalid metadata setting.' };
    }
    allowed.stripMetadata = body.stripMetadata;
  }
  if (body.frameRate !== undefined) {
    if (body.frameRate === null) allowed.frameRate = null;
    else {
      const value = Number(body.frameRate);
      if (!Number.isInteger(value) || value < FRAME_RATE_MIN || value > FRAME_RATE_MAX) {
        return { ok: false, error: 'Invalid frame rate.' };
      }
      allowed.frameRate = value;
    }
  }
  if (body.resolutionLimit !== undefined) {
    if (body.resolutionLimit === null) allowed.resolutionLimit = null;
    else {
      const value = Number(body.resolutionLimit);
      if (!Number.isInteger(value) || value < RESOLUTION_MIN || value > RESOLUTION_MAX) {
        return { ok: false, error: 'Invalid resolution.' };
      }
      allowed.resolutionLimit = value;
    }
  }
  if (body.rateControl !== undefined) {
    if (!['crf', 'bitrate'].includes(body.rateControl)) {
      return { ok: false, error: 'Invalid rate control.' };
    }
    allowed.rateControl = body.rateControl;
  }
  if (body.crf !== undefined) {
    const value = Number(body.crf);
    if (!Number.isInteger(value) || value < CRF_MIN || value > CRF_MAX) {
      return { ok: false, error: 'Invalid quality.' };
    }
    allowed.crf = value;
  }
  if (body.videoBitrateKbps !== undefined) {
    const value = Number(body.videoBitrateKbps);
    if (
      !Number.isInteger(value) ||
      value < VIDEO_BITRATE_MIN_KBPS ||
      value > VIDEO_BITRATE_MAX_KBPS
    ) {
      return { ok: false, error: 'Invalid bitrate.' };
    }
    allowed.videoBitrateKbps = value;
  }
  if (body.imageEmbedding !== undefined) {
    if (!body.imageEmbedding || typeof body.imageEmbedding !== 'object') {
      return { ok: false, error: 'Invalid image embedding settings.' };
    }
    if (
      'startImage' in body.imageEmbedding ||
      'endImage' in body.imageEmbedding ||
      'startImages' in body.imageEmbedding ||
      'endImages' in body.imageEmbedding
    ) {
      return { ok: false, error: 'Image assets must be selected through the image API.' };
    }
    const imageEmbedding = { ...currentImageEmbedding };
    if (body.imageEmbedding.enabled !== undefined) {
      if (typeof body.imageEmbedding.enabled !== 'boolean') {
        return { ok: false, error: 'Invalid image embedding mode.' };
      }
      imageEmbedding.enabled = body.imageEmbedding.enabled;
    }
    if (body.imageEmbedding.disabledImageIds !== undefined) {
      const ids = body.imageEmbedding.disabledImageIds;
      if (
        !Array.isArray(ids) ||
        ids.length > 500 ||
        ids.some(id => typeof id !== 'string' || id.length < 1 || id.length > 128)
      ) {
        return { ok: false, error: 'Invalid disabled image list.' };
      }
      imageEmbedding.disabledImageIds = [...new Set(ids)];
    }
    if (body.imageEmbedding.replaceExisting !== undefined) {
      if (typeof body.imageEmbedding.replaceExisting !== 'boolean') {
        return { ok: false, error: 'Invalid replace-existing setting.' };
      }
      imageEmbedding.replaceExisting = body.imageEmbedding.replaceExisting;
    }
    if (body.imageEmbedding.finalDurationMode !== undefined) {
      if (
        !['random-30-40', 'random-40-50', 'random-50-60', 'custom'].includes(
          body.imageEmbedding.finalDurationMode
        )
      ) {
        return { ok: false, error: 'Invalid final image duration mode.' };
      }
      imageEmbedding.finalDurationMode = body.imageEmbedding.finalDurationMode;
    }
    if (body.imageEmbedding.customFinalDurationSeconds !== undefined) {
      const value = Number(body.imageEmbedding.customFinalDurationSeconds);
      if (
        !Number.isInteger(value) ||
        value < MIN_CUSTOM_FINAL_IMAGE_DURATION_SECONDS ||
        value > MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS
      ) {
        return { ok: false, error: 'INVALID_CUSTOM_IMAGE_DURATION' };
      }
      imageEmbedding.customFinalDurationSeconds = value;
    }
    if (body.imageEmbedding.startDurationMode !== undefined) {
      if (
        !['one-frame', 'ms-2', 'ms-5', 'ms-10', 'custom'].includes(
          body.imageEmbedding.startDurationMode
        )
      ) {
        return { ok: false, error: 'Invalid start image duration mode.' };
      }
      imageEmbedding.startDurationMode = body.imageEmbedding.startDurationMode;
    }
    if (body.imageEmbedding.customStartDurationMs !== undefined) {
      const value = Number(body.imageEmbedding.customStartDurationMs);
      if (
        !Number.isInteger(value) ||
        value < MIN_CUSTOM_START_IMAGE_DURATION_MS ||
        value > MAX_CUSTOM_START_IMAGE_DURATION_MS
      ) {
        return { ok: false, error: 'INVALID_CUSTOM_START_IMAGE_DURATION' };
      }
      imageEmbedding.customStartDurationMs = value;
    }
    if (body.imageEmbedding.fitMode !== undefined) {
      if (!['cover', 'contain', 'stretch'].includes(body.imageEmbedding.fitMode)) {
        return { ok: false, error: 'Invalid image fit mode.' };
      }
      imageEmbedding.fitMode = body.imageEmbedding.fitMode;
    }
    allowed.imageEmbedding = imageEmbedding;
  }
  return { ok: true, patch: allowed };
}

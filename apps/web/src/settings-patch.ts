import type { AgentSettingsPatch } from '@video-compressor/shared';

/** Merge debounced settings without expanding the image patch with asset fields. */
export function mergeSettingsPatches(
  current: AgentSettingsPatch,
  next: AgentSettingsPatch
): AgentSettingsPatch {
  const merged: AgentSettingsPatch = { ...current, ...next };
  if (current.imageEmbedding || next.imageEmbedding) {
    merged.imageEmbedding = {
      ...current.imageEmbedding,
      ...next.imageEmbedding
    };
  }
  return merged;
}

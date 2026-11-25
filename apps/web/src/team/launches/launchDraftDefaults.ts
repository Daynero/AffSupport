import {
  builtinLaunchDraft,
  launchCreativeAlias,
  type LaunchDraft
} from '@video-compressor/shared';
import { launchBrowserTimezone } from './launchTimezone';

/** 064: the built-in values live in shared, so the assistant builds the same draft as the form. */
export function newLaunchDraft(): LaunchDraft {
  return builtinLaunchDraft(new Date(), launchBrowserTimezone());
}

/**
 * A new launch opened with a creative already chosen (Explorer's «Launch»): the same
 * creative fields the picker writes, with the alias made from the file name the same way.
 */
export function withInitialCreative(
  draft: LaunchDraft,
  materialId: string | null | undefined,
  materialName?: string | null
): LaunchDraft {
  if (!materialId) return draft;
  const name = materialName?.trim();
  return { ...draft, materialId, ...(name ? { creativeAlias: launchCreativeAlias(name) } : {}) };
}

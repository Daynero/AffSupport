import { builtinLaunchDraft, type LaunchDraft } from '@video-compressor/shared';
import { launchBrowserTimezone } from './launchTimezone';

/** 064: the built-in values live in shared, so the assistant builds the same draft as the form. */
export function newLaunchDraft(): LaunchDraft {
  return builtinLaunchDraft(new Date(), launchBrowserTimezone());
}

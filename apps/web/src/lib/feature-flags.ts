import { useEffect, useState } from 'react';

// A lightweight, web-only acknowledgment gate for features that are still
// being finished but need to ship to production for testing. It is
// deliberately NOT security: it only asks the user to confirm they understand
// the feature is a work in progress before opening it, so casual users do not
// stumble into an unfinished tool unaware. It does not touch the local agent,
// its API, its endpoints, or any of its logic.
//
// To open a feature to everyone without the warning, flip its `protected`
// flag to false.

export type FeatureId =
  'videoCompressor' | 'landingOptimizer' | 'landingPreview' | 'transcription' | 'teamWorkspace';

type FeatureFlag = { protected: boolean };

export const featureFlags: Record<FeatureId, FeatureFlag> = {
  videoCompressor: { protected: false },
  landingOptimizer: { protected: false },
  landingPreview: { protected: false },
  // Transcription is available to beta testers without a development-warning
  // acknowledgment. Its beta label is presentation-only in the tool registry.
  transcription: { protected: false },
  // Team workspace is controlled by membership authorization, not a
  // browser-local development acknowledgement.
  teamWorkspace: { protected: false }
};

const STORAGE_PREFIX = 'wishly.feature-unlock.';
const UNLOCK_EVENT = 'wishly-feature-unlock';

export function isProtected(feature: FeatureId): boolean {
  return featureFlags[feature].protected;
}

export function isUnlocked(feature: FeatureId): boolean {
  if (!isProtected(feature)) return true;
  try {
    return localStorage.getItem(STORAGE_PREFIX + feature) === 'true';
  } catch {
    // Storage blocked (private mode, etc.) — treat as locked until unlocked.
    return false;
  }
}

/** A protected feature this browser has not unlocked yet. */
export function isLocked(feature: FeatureId): boolean {
  return isProtected(feature) && !isUnlocked(feature);
}

/**
 * Persist the user's "I understand this is a work in progress" acknowledgment
 * for this browser and notify listeners so locked UI opens up.
 */
export function unlockFeature(feature: FeatureId): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + feature, 'true');
  } catch {
    // Storage unavailable — the unlock still applies for this tab via the event.
  }
  window.dispatchEvent(new Event(UNLOCK_EVENT));
}

/** Reactively track whether a feature is currently locked for this browser. */
export function useFeatureLock(feature: FeatureId): boolean {
  const [locked, setLocked] = useState(() => isLocked(feature));
  useEffect(() => {
    const update = () => setLocked(isLocked(feature));
    update();
    window.addEventListener(UNLOCK_EVENT, update);
    // `storage` fires when another tab unlocks the same feature.
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(UNLOCK_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [feature]);
  return locked;
}

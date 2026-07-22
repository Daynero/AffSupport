import { useEffect, useState } from 'react';

// A lightweight, web-only access gate for features that are still being
// finished but need to ship to production for testing. It is deliberately NOT
// security: it only hides UI behind a shared developer pass so casual users do
// not stumble into an unfinished tool. It does not touch the local agent, its
// API, its endpoints, or any of its logic.
//
// To open a feature to everyone, flip its `protected` flag to false.

export type FeatureId = 'videoCompressor' | 'landingOptimizer' | 'transcription';

type FeatureFlag = { protected: boolean };

export const featureFlags: Record<FeatureId, FeatureFlag> = {
  videoCompressor: { protected: false },
  landingOptimizer: { protected: false },
  transcription: { protected: true }
};

// The pass that unlocks protected features. Overridable per build via
// VITE_DEVELOPER_PASS; falls back to a shared default for local development.
export const developerPass =
  (import.meta.env.VITE_DEVELOPER_PASS as string | undefined)?.trim() || 'Test111';

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
 * Validate the pass and, if it matches, persist the unlock for this browser and
 * notify listeners. Returns whether the pass was correct.
 */
export function unlockFeature(feature: FeatureId, pass: string): boolean {
  if (pass.trim() !== developerPass) return false;
  try {
    localStorage.setItem(STORAGE_PREFIX + feature, 'true');
  } catch {
    // Storage unavailable — the unlock still applies for this tab via the event.
  }
  window.dispatchEvent(new Event(UNLOCK_EVENT));
  return true;
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

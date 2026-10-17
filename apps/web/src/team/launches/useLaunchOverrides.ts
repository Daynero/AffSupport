import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaunchDetail, LaunchOverrides } from '@video-compressor/shared';
import { launchValuesEqual } from '@video-compressor/shared';
/** Keep unsaved output edits attached to the revision/version the user actually saw. */
export function useLaunchOverrides(detail: LaunchDetail | null) {
  const [revision, setRevision] = useState(detail?.activeRevision ?? null);
  const [overrides, setOverrides] = useState<LaunchOverrides>(
    detail?.activeRevision?.overrides ?? {}
  );
  const [baseVersion, setBaseVersion] = useState(detail?.version ?? null);
  const saved = useRef<LaunchOverrides>(detail?.activeRevision?.overrides ?? {});
  const dirty = !launchValuesEqual(overrides, saved.current);
  useEffect(() => {
    if (!dirty) {
      setRevision(detail?.activeRevision ?? null);
      setOverrides(detail?.activeRevision?.overrides ?? {});
      setBaseVersion(detail?.version ?? null);
      saved.current = detail?.activeRevision?.overrides ?? {};
    }
  }, [detail, dirty]);
  const acknowledge = useCallback(
    (value: LaunchOverrides = overrides) => {
      saved.current = value;
    },
    [overrides]
  );
  const discard = useCallback(() => {
    const baseline = revision?.overrides ?? {};
    saved.current = baseline;
    setOverrides(baseline);
  }, [revision]);
  const advanceBase = useCallback((version: string) => setBaseVersion(version), []);
  const replace = useCallback((next: LaunchDetail) => {
    const value = next.activeRevision?.overrides ?? {};
    saved.current = value;
    setRevision(next.activeRevision);
    setOverrides(value);
    setBaseVersion(next.version);
  }, []);
  return {
    revision,
    overrides,
    setOverrides,
    baseVersion,
    dirty,
    acknowledge,
    advanceBase,
    discard,
    replace,
    isDirty: () => !launchValuesEqual(overrides, saved.current)
  };
}

/** Rebase only local field edits, preserving unrelated changes from another session. */
export function mergeLaunchOverrides(
  base: LaunchOverrides,
  local: LaunchOverrides,
  remote: LaunchOverrides
): LaunchOverrides {
  const result: LaunchOverrides = { ...remote };
  for (const key of ['advertisingUrl', 'catalogName', 'catalogUrl'] as const) {
    if (local[key] === base[key]) continue;
    if (local[key] === undefined) delete result[key];
    else result[key] = local[key];
  }
  const mergeMap = (key: 'subValues' | 'campaigns') => {
    const baseMap = (base[key] ?? {}) as Record<string, unknown>;
    const localMap = (local[key] ?? {}) as Record<string, unknown>;
    const resultMap = { ...((remote[key] ?? {}) as Record<string, unknown>) };
    for (const entry of new Set([...Object.keys(baseMap), ...Object.keys(localMap)])) {
      if (JSON.stringify(localMap[entry]) === JSON.stringify(baseMap[entry])) continue;
      if (key === 'campaigns') {
        const baseCampaign = (baseMap[entry] ?? {}) as Record<string, unknown>;
        const localCampaign = (localMap[entry] ?? {}) as Record<string, unknown>;
        const mergedCampaign = { ...((resultMap[entry] ?? {}) as Record<string, unknown>) };
        for (const field of new Set([
          ...Object.keys(baseCampaign),
          ...Object.keys(localCampaign)
        ])) {
          if (localCampaign[field] === baseCampaign[field]) continue;
          if (localCampaign[field] === undefined) delete mergedCampaign[field];
          else mergedCampaign[field] = localCampaign[field];
        }
        if (Object.keys(mergedCampaign).length) resultMap[entry] = mergedCampaign;
        else delete resultMap[entry];
      } else if (localMap[entry] === undefined) delete resultMap[entry];
      else resultMap[entry] = localMap[entry];
    }
    if (Object.keys(resultMap).length) result[key] = resultMap as never;
    else delete result[key];
  };
  mergeMap('subValues');
  mergeMap('campaigns');
  return result;
}

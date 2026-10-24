import { useCallback, useEffect, useRef, useState } from 'react';
import {
  launchValuesEqual,
  type LaunchDraft,
  type LaunchDetail,
  type LaunchSourceSnapshot
} from '@video-compressor/shared';
import { newLaunchDraft } from './launchDraftDefaults';
export function useLaunchDraft(detail: LaunchDetail | null, materialId?: string | null) {
  const [config, setConfig] = useState<LaunchDraft>(
    () => detail?.draft ?? { ...newLaunchDraft(), ...(materialId ? { materialId } : {}) }
  );
  const [sources, setSources] = useState<LaunchSourceSnapshot | null>(
    detail?.expectedSourceSnapshot ?? null
  );
  const [baseVersion, setBaseVersion] = useState(detail?.version ?? null);
  const saved = useRef({
    config: detail?.draft ?? config,
    sources: detail?.expectedSourceSnapshot ?? null
  });
  const id = useRef(detail?.id ?? null);
  const current = useRef({ config, sources });
  current.current = { config, sources };
  const dirty = !launchValuesEqual({ config, sources }, saved.current);
  useEffect(() => {
    if ((detail?.id ?? null) !== id.current) {
      const adoptingOwnDraft =
        id.current === null &&
        detail !== null &&
        launchValuesEqual(saved.current.config, detail.draft);
      id.current = detail?.id ?? null;
      setBaseVersion(detail?.version ?? null);
      const next = detail?.draft ?? newLaunchDraft();
      saved.current = {
        config: next,
        sources: detail?.expectedSourceSnapshot ?? null
      };
      if (!adoptingOwnDraft) {
        setConfig(next);
        setSources(detail?.expectedSourceSnapshot ?? null);
      }
    } else if (detail && !dirty) {
      setBaseVersion(detail.version);
      saved.current = {
        config: detail.draft,
        sources: detail.expectedSourceSnapshot
      };
      setConfig(detail.draft);
      setSources(detail.expectedSourceSnapshot);
    }
  }, [detail, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const acknowledge = (
    draft: LaunchDraft,
    expectedSources: LaunchSourceSnapshot | null = sources,
    version?: string
  ) => {
    saved.current = { config: draft, sources: expectedSources };
    if (version !== undefined) setBaseVersion(version);
  };
  const resolveSources = useCallback((next: LaunchSourceSnapshot) => {
    // Filling an initially absent authoritative snapshot is not an edit.
    // A changed configuration or a previously saved snapshot still stays dirty.
    if (
      current.current.sources === null &&
      saved.current.sources === null &&
      launchValuesEqual(current.current.config, saved.current.config)
    )
      saved.current.sources = next;
    setSources(next);
  }, []);
  return {
    config,
    setConfig,
    sources,
    setSources,
    resolveSources,
    dirty,
    acknowledge,
    baseVersion,
    isDirty: () => !launchValuesEqual({ config, sources }, saved.current)
  };
}

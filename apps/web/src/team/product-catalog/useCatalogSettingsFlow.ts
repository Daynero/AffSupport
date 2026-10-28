import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  beginCatalogUiFlow,
  type CatalogUiFailure,
  type CatalogUiFlow,
  type CatalogUiStage
} from '../catalog-updater/analytics';

/** One instance per independent editor. Tokens fence replies from superseded requests. */
export function useCatalogSettingsFlow() {
  const flow = useRef<CatalogUiFlow | null>(null);
  const [visibleAttempt, setVisibleAttempt] = useState<string | null>(null);
  useEffect(() => {
    if (visibleAttempt && flow.current?.id === visibleAttempt) flow.current.complete();
  }, [visibleAttempt]);
  useEffect(
    () => () => {
      flow.current?.cancel();
      flow.current = null;
    },
    []
  );

  const start = useCallback(() => {
    flow.current?.cancel();
    flow.current = beginCatalogUiFlow('template');
    return flow.current.id;
  }, []);
  const stage = useCallback((value: CatalogUiStage, attempt?: string) => {
    if (!attempt || flow.current?.id === attempt) flow.current?.stage(value);
  }, []);
  const fail = useCallback((code: CatalogUiFailure, attempt?: string) => {
    if (!attempt || flow.current?.id === attempt) flow.current?.fail(code);
  }, []);
  // Call alongside the state update that displays the confirmed server result.
  const confirm = useCallback((attempt?: string) => {
    if (flow.current && (!attempt || flow.current.id === attempt)) {
      setVisibleAttempt(flow.current.id);
    }
  }, []);
  return useMemo(() => ({ start, stage, fail, confirm }), [start, stage, fail, confirm]);
}

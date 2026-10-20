import { useCallback, useRef, useState } from 'react';
import { parseFinanceMoney, type FinanceField, type FinanceMetric } from '@video-compressor/shared';

/** Dated edits belong to the workspace, never to a particular mounted row. */
export interface FinanceDraft {
  key: string;
  agentRowId: string;
  date: string;
  metric: FinanceMetric;
  currency: 'USD';
  timezone: string;
  raw: string;
  baseVersion: string;
  placementId: string;
  requestId: string;
  status: 'dirty' | 'pending' | 'failed' | 'unknown';
  error?: string;
  generation: number;
  intent: 'normal' | 'historical_correction';
}
export function financeDraftKey(
  user: string,
  team: string,
  agent: string,
  date: string,
  metric: FinanceMetric
) {
  return [user, team, agent, date, metric, 'USD'].join('/');
}
export function useFinanceDrafts() {
  const records = useRef(new Map<string, FinanceDraft>());
  const [, render] = useState(0);
  const generation = useRef(0);
  const update = useCallback((key: string, change: FinanceDraft | null) => {
    if (change) records.current.set(key, change);
    else records.current.delete(key);
    generation.current += 1;
    render(n => n + 1);
  }, []);
  const edit = useCallback(
    (
      context: Omit<FinanceDraft, 'raw' | 'baseVersion' | 'requestId' | 'status' | 'generation'>,
      raw: string,
      field?: FinanceField
    ) => {
      const old = records.current.get(context.key);
      if (old?.status === 'pending') return;
      update(context.key, {
        ...context,
        raw,
        baseVersion: old?.baseVersion ?? field?.version ?? '0',
        placementId: old?.placementId ?? context.placementId,
        requestId: crypto.randomUUID(),
        status: 'dirty',
        generation: generation.current + 1
      });
    },
    [update]
  );
  const getAffectedDrafts = useCallback(
    (agents?: readonly string[]) =>
      [...records.current.values()].filter(d => !agents || agents.includes(d.agentRowId)),
    []
  );
  const discardSubset = useCallback(
    (agents?: readonly string[]) => {
      for (const draft of getAffectedDrafts(agents))
        if (draft.status !== 'pending') update(draft.key, null);
    },
    [getAffectedDrafts, update]
  );
  const validate = useCallback(
    (agents?: readonly string[]) =>
      getAffectedDrafts(agents).every(d => parseFinanceMoney(d.raw) !== undefined),
    [getAffectedDrafts]
  );
  return {
    records: records.current,
    generation,
    update,
    edit,
    getAffectedDrafts,
    discardSubset,
    validate
  };
}

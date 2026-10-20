import { useEffect, useRef, useState } from 'react';
import type {
  CatalogUpdateProfile,
  CatalogUpdateProfilePatch,
  CatalogUpdateSchedule
} from '@video-compressor/shared';
import { TeamApiError, type CatalogRegistryRow, type CatalogUpdaterInterval } from '../../api/team';
import type { CatalogUpdaterClient } from './useCatalogUpdater';
import { catalogNextRunPreview } from './catalogSchedulePreview';
import { beginCatalogUiFlow, type CatalogUiFlow } from './analytics';

export type CatalogField = keyof CatalogUpdateProfilePatch;
export interface CatalogSnapshot {
  profile: CatalogUpdateProfile;
  interval: CatalogUpdaterInterval | null;
  nextRunAt?: string | null;
}
export interface CatalogScheduleSelection {
  interval: CatalogUpdaterInterval | null;
  schedule: CatalogUpdateSchedule | null;
}
export type Value = boolean | CatalogUpdaterInterval | null | CatalogScheduleSelection;
export interface InlineChangeState {
  phase: 'pending' | 'saved' | 'error' | 'unknown' | 'conflict';
  field: CatalogField;
  intended: Value;
  code?: string;
}
export interface CatalogUndo {
  catalogId: string;
  field: CatalogField;
  before: Value;
  after: Value;
  version: number;
  invalid?: boolean;
}
const readValue = (snapshot: CatalogSnapshot, field: CatalogField): Value =>
  field === 'schedule'
    ? { interval: snapshot.interval, schedule: snapshot.profile.schedule ?? null }
    : field === 'updateInterval'
      ? snapshot.interval
      : snapshot.profile[field];
const equal = (a: Value, b: Value) =>
  typeof a === 'object' && a !== null && typeof b === 'object' && b !== null
    ? a.interval === b.interval &&
      a.schedule?.time === b.schedule?.time &&
      a.schedule?.weekday === b.schedule?.weekday &&
      a.schedule?.timeZone === b.schedule?.timeZone
    : a === b;
const intervalAfter = (field: CatalogField, value: Value, before: CatalogUpdaterInterval | null) =>
  field === 'schedule'
    ? (value as CatalogScheduleSelection).interval
    : field === 'updateInterval'
      ? (value as CatalogUpdaterInterval | null)
      : before;

/** One writer shared by the row and detail surface. No retry until an uncertain write is read back. */
export function useCatalogInlineChanges({
  teamId,
  client,
  rows,
  reload,
  onChanged,
  clockOffsetMs = 0
}: {
  teamId: string;
  client: CatalogUpdaterClient;
  rows: CatalogRegistryRow[];
  reload: () => void;
  onChanged?: () => void;
  clockOffsetMs?: number;
}) {
  const [snapshots, setSnapshots] = useState<Record<string, CatalogSnapshot>>({});
  const [states, setStates] = useState<Record<string, InlineChangeState>>({});
  const [undo, setUndo] = useState<CatalogUndo[]>([]);
  const locks = useRef(new Set<string>());
  const current = useRef({ rows, snapshots });
  current.current = { rows, snapshots };
  const visibleFlows = useRef(new Map<string, CatalogUiFlow>());
  useEffect(
    () => () => {
      for (const flow of visibleFlows.current.values()) flow.cancel();
    },
    []
  );
  const snapshotFor = (id: string): CatalogSnapshot | undefined => {
    const row = current.current.rows.find(row => row.catalogId === id);
    const local = current.current.snapshots[id];
    if (row?.profile && (!local || row.profile.version >= local.profile.version))
      return { profile: row.profile, interval: row.updateInterval, nextRunAt: row.nextRunAt };
    return (
      local ??
      (row?.profile
        ? { profile: row.profile, interval: row.updateInterval, nextRunAt: row.nextRunAt }
        : undefined)
    );
  };
  const publish = (id: string, snapshot: CatalogSnapshot) => {
    current.current.snapshots = { ...current.current.snapshots, [id]: snapshot };
    setSnapshots(current.current.snapshots);
  };
  const read = async (id: string): Promise<CatalogSnapshot> => {
    const [profiles, catalogs] = await Promise.all([
      client.listCatalogUpdateProfiles?.(teamId),
      client.listTeamProductCatalogs(teamId)
    ]);
    const catalog = catalogs.find(row => row.catalogId === id);
    const profile = profiles?.find(profile => profile.catalogId === id) ?? catalog?.profile;
    if (!profile || !catalog) throw new Error('Catalog profile unavailable');
    return { profile, interval: catalog.updateInterval, nextRunAt: catalog.nextRunAt };
  };
  const settle = (
    id: string,
    field: CatalogField,
    value: Value,
    before: Value,
    snapshot: CatalogSnapshot,
    flow: CatalogUiFlow,
    isUndo: boolean
  ) => {
    publish(id, snapshot);
    setStates(current => ({ ...current, [id]: { phase: 'saved', field, intended: value } }));
    setUndo(current =>
      isUndo
        ? current.filter(item => !(item.catalogId === id && item.field === field))
        : [
            ...current.filter(item => !(item.catalogId === id && item.field === field)),
            { catalogId: id, field, before, after: value, version: snapshot.profile.version }
          ]
    );
    visibleFlows.current.get(id)?.cancel();
    visibleFlows.current.set(id, flow);
    reload();
    onChanged?.();
  };
  const change = async (id: string, field: CatalogField, value: Value, undoEntry?: CatalogUndo) => {
    if (locks.current.has(id) || !client.patchCatalogUpdateProfile) return false;
    const base = snapshotFor(id);
    if (!base) return false;
    if (!undoEntry && equal(readValue(base, field), value)) return true;
    let confirmed = false;
    locks.current.add(id);
    setStates(current => ({ ...current, [id]: { phase: 'pending', field, intended: value } }));
    const flow = beginCatalogUiFlow('profile', {
      count: 1,
      field: field === 'schedule' ? 'updateInterval' : field
    });
    flow.stage(undoEntry ? 'undo_requested' : 'draft_changed');
    const before = readValue(base, field);
    let expected = base;
    try {
      if (undoEntry) {
        expected = await read(id);
        publish(id, expected);
        if (
          expected.profile.version !== undoEntry.version ||
          !equal(readValue(expected, field), undoEntry.after)
        ) {
          setUndo(current =>
            current.map(item => (item === undoEntry ? { ...item, invalid: true } : item))
          );
          setStates(current => ({
            ...current,
            [id]: { phase: 'conflict', field, intended: value, code: 'STALE_RESULT' }
          }));
          flow.fail('CONFLICT');
          return false;
        }
      }
      flow.stage('save_requested');
      const profile = await client.patchCatalogUpdateProfile(
        teamId,
        id,
        expected.profile.version,
        (field === 'schedule'
          ? {
              updateInterval: (value as CatalogScheduleSelection).interval,
              schedule: (value as CatalogScheduleSelection).schedule
            }
          : { [field]: value }) as CatalogUpdateProfilePatch
      );
      if (
        !equal(
          readValue(
            {
              profile,
              interval: intervalAfter(field, value, expected.interval)
            },
            field
          ),
          value
        )
      )
        throw new Error('Unconfirmed mutation');
      confirmed = true;
      flow.stage('save_confirmed');
      settle(
        id,
        field,
        value,
        before,
        {
          profile,
          interval: intervalAfter(field, value, expected.interval),
          nextRunAt:
            field === 'schedule' || field === 'updateInterval'
              ? catalogNextRunPreview(
                  intervalAfter(field, value, expected.interval),
                  profile.schedule,
                  new Date(Date.now() + clockOffsetMs)
                )
              : expected.nextRunAt
        },
        flow,
        Boolean(undoEntry)
      );
    } catch (cause) {
      const conflict = cause instanceof TeamApiError && cause.code === 'STALE_RESULT';
      // A typed server rejection proves no write. Transport failures require reconciliation.
      if (
        cause instanceof TeamApiError &&
        !conflict &&
        !cause.retryable &&
        cause.code !== 'INVALID_RESPONSE'
      ) {
        setStates(current => ({
          ...current,
          [id]: { phase: 'error', field, intended: value, code: cause.code }
        }));
        flow.fail('SAVE_FAILED');
      } else {
        flow.stage(conflict ? 'conflict' : 'readback_requested');
        try {
          const latest = await read(id);
          publish(id, latest);
          if (
            !conflict &&
            latest.profile.version === expected.profile.version + 1 &&
            equal(readValue(latest, field), value)
          ) {
            confirmed = true;
            flow.stage('save_confirmed');
            settle(id, field, value, before, latest, flow, Boolean(undoEntry));
          } else {
            setStates(current => ({
              ...current,
              [id]: {
                phase: conflict ? 'conflict' : 'unknown',
                field,
                intended: value,
                code: conflict ? 'STALE_RESULT' : 'UNKNOWN'
              }
            }));
            flow.fail(conflict ? 'CONFLICT' : 'UNKNOWN');
          }
        } catch {
          setStates(current => ({
            ...current,
            [id]: { phase: 'unknown', field, intended: value, code: 'UNKNOWN' }
          }));
          flow.fail('UNKNOWN');
        }
      }
    } finally {
      locks.current.delete(id);
    }
    return confirmed;
  };
  const reconcile = async (id: string) => {
    if (locks.current.has(id)) return;
    locks.current.add(id);
    const flow = beginCatalogUiFlow('profile', { count: 1 });
    flow.stage('readback_requested');
    try {
      publish(id, await read(id));
      setStates(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      visibleFlows.current.set(id, flow);
      reload();
    } catch {
      flow.fail('READ_FAILED');
    } finally {
      locks.current.delete(id);
    }
  };
  const blocked = (id: string) => locks.current.has(id) || states[id]?.phase === 'unknown';
  const delivered = (id: string) => {
    const flow = visibleFlows.current.get(id);
    flow?.stage('result_visible');
    flow?.complete();
    visibleFlows.current.delete(id);
  };
  useEffect(() => {
    const saved = Object.entries(states).filter(([, state]) => state.phase === 'saved');
    if (!saved.length) return;
    const timer = window.setTimeout(
      () =>
        setStates(current => {
          const next = { ...current };
          for (const [id, state] of saved) if (next[id] === state) delete next[id];
          return next;
        }),
      3000
    );
    return () => window.clearTimeout(timer);
  }, [states]);
  const hasPending = Object.values(states).some(
    state => state.phase === 'pending' || state.phase === 'unknown'
  );
  useEffect(() => {
    if (!hasPending) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [hasPending]);
  return {
    snapshotFor,
    states,
    undo,
    change,
    reconcile,
    blocked,
    hasPending,
    delivered,
    clearUndo: () => setUndo([]),
    undoChange: (entry: CatalogUndo) => change(entry.catalogId, entry.field, entry.before, entry)
  };
}
export type CatalogInlineChanges = ReturnType<typeof useCatalogInlineChanges>;

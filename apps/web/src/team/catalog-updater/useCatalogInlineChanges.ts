import { usePrivateCacheEpoch } from '../private-cache-scope';
import { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import { readCatalogSnapshot } from './readCatalogSnapshot';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CatalogUpdateProfile,
  CatalogUpdateProfilePatch,
  CatalogUpdateSchedule
} from '@video-compressor/shared';
import { TeamApiError, type CatalogRegistryRow, type CatalogUpdaterInterval } from '../../api/team';
import type { CatalogUpdaterClient } from './useCatalogUpdater';
import { saveCatalogProfile } from './saveCatalogProfile';
import { beginCatalogUiFlow, type CatalogUiFlow } from './analytics';

export type CatalogField = keyof CatalogUpdateProfilePatch;
export interface CatalogSnapshot {
  profile: CatalogUpdateProfile;
  interval: CatalogUpdaterInterval | null;
  nextRunAt?: string | null;
  runtimeObservedAt?: string;
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

/** One writer shared by the row and detail surface. No retry until an uncertain write is read back. */
export function useCatalogInlineChanges({
  teamId,
  client,
  rows,
  reload,
  onChanged
}: {
  teamId: string;
  client: CatalogUpdaterClient;
  rows: CatalogRegistryRow[];
  reload: () => void;
  onChanged?: () => void;
  clockOffsetMs?: number;
}) {
  const privateEpoch = usePrivateCacheEpoch();
  const generation = useRef(0);
  const mounted = useRef(true);
  const snapshotCache = useRef(new Map<string, CatalogSnapshot>());
  const unknownIntents = useRef(
    new Map<
      string,
      {
        base: CatalogSnapshot;
        patch: CatalogUpdateProfilePatch;
        field: CatalogField;
        value: Value;
        before: Value;
        isUndo: boolean;
      }
    >()
  );
  const previousScope = useRef({ teamId, client, privateEpoch });
  if (
    previousScope.current.teamId !== teamId ||
    previousScope.current.client !== client ||
    previousScope.current.privateEpoch !== privateEpoch
  ) {
    generation.current += 1;
    snapshotCache.current.clear();
    unknownIntents.current.clear();
    previousScope.current = { teamId, client, privateEpoch };
  }
  const owner = useMemo(() => {
    const scope = previousScope.current;
    return captureCatalogMutationOwner(() => mounted.current && previousScope.current === scope);
  }, [teamId, client, privateEpoch]);
  const readControllers = useRef(new Set<AbortController>());
  const [snapshots, setSnapshots] = useState<Record<string, CatalogSnapshot>>({});
  const [states, setStates] = useState<Record<string, InlineChangeState>>({});
  const [undo, setUndo] = useState<CatalogUndo[]>([]);
  const locks = useRef(new Set<string>());
  const rowById = useMemo(() => new Map(rows.map(row => [row.catalogId, row])), [rows]);
  const current = useRef({ rowById, snapshots });
  current.current = { rowById, snapshots };
  const visibleFlows = useRef(new Map<string, CatalogUiFlow>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      unknownIntents.current.clear();
      for (const controller of readControllers.current) controller.abort();
      for (const flow of visibleFlows.current.values()) flow.cancel();
    };
  }, []);
  useEffect(() => {
    setSnapshots({});
    setStates({});
    setUndo([]);
    locks.current.clear();
  }, [teamId, client, privateEpoch]);
  const remember = (
    id: string,
    incoming: CatalogSnapshot,
    acknowledged = false
  ): CatalogSnapshot => {
    const previous = snapshotCache.current.get(id);
    if (!previous) {
      snapshotCache.current.set(id, incoming);
      return incoming;
    }
    const previousTime = Date.parse(previous.runtimeObservedAt ?? '');
    const incomingTime = Date.parse(incoming.runtimeObservedAt ?? '');
    const runtime =
      (Number.isFinite(previousTime) &&
        (!Number.isFinite(incomingTime) || incomingTime <= previousTime)) ||
      (!Number.isFinite(incomingTime) && incoming.profile.version < previous.profile.version)
        ? previous
        : incoming;
    const settings =
      incoming.profile.version > previous.profile.version ||
      (incoming.profile.version === previous.profile.version && acknowledged)
        ? incoming
        : previous;
    const merged = {
      ...runtime,
      profile: {
        ...runtime.profile,
        refreshImages: settings.profile.refreshImages,
        refreshTexts: settings.profile.refreshTexts,
        growProducts: settings.profile.growProducts,
        randomLinkVariation: settings.profile.randomLinkVariation,
        restitch: settings.profile.restitch,
        schedule: settings.profile.schedule,
        version: settings.profile.version,
        updatedAt: settings.profile.updatedAt
      },
      interval: settings.interval
    };
    snapshotCache.current.set(id, merged);
    return merged;
  };
  const snapshotFor = (id: string): CatalogSnapshot | undefined => {
    const row = current.current.rowById.get(id);
    return row?.profile
      ? remember(id, {
          profile: row.profile,
          interval: row.updateInterval,
          nextRunAt: row.nextRunAt,
          runtimeObservedAt: row.runtimeObservedAt
        })
      : snapshotCache.current.get(id);
  };
  const publish = (id: string, snapshot: CatalogSnapshot) => {
    const merged = remember(id, snapshot, true);
    current.current.snapshots = { ...current.current.snapshots, [id]: merged };
    setSnapshots(current.current.snapshots);
  };
  const read = async (id: string): Promise<CatalogSnapshot> => {
    if (!owner.current()) throw new DOMException('Catalog scope changed', 'AbortError');
    const controller = new AbortController();
    readControllers.current.add(controller);
    try {
      return await readCatalogSnapshot(client, teamId, id, controller.signal);
    } finally {
      readControllers.current.delete(controller);
    }
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
  const mutate = async (
    id: string,
    field: CatalogField,
    value: Value,
    undoEntry?: CatalogUndo
  ): Promise<{ confirmed: boolean; error?: unknown }> => {
    const epoch = generation.current;
    const active = () => generation.current === epoch && owner.current();
    const obsolete = () => ({
      confirmed: false,
      error: new DOMException('Catalog scope changed', 'AbortError')
    });
    if (!active()) return obsolete();
    if (
      locks.current.has(id) ||
      unknownIntents.current.has(id) ||
      !client.patchCatalogUpdateProfile
    )
      return { confirmed: false, error: new TeamApiError('WRONG_STATE', false) };
    const base = snapshotFor(id);
    if (!base) return { confirmed: false, error: new TeamApiError('NOT_FOUND', false) };
    if (!undoEntry && equal(readValue(base, field), value)) return { confirmed: true };
    let confirmed = false;
    let failure: unknown = new Error('Catalog save outcome is unknown');
    locks.current.add(id);
    setStates(current => ({ ...current, [id]: { phase: 'pending', field, intended: value } }));
    const flow = beginCatalogUiFlow('profile', {
      count: 1,
      field: field === 'schedule' ? 'updateInterval' : field
    });
    flow.stage(undoEntry ? 'undo_requested' : 'draft_changed');
    const before = readValue(base, field);
    let expected = base;
    let writeSent = false;
    const patch = (
      field === 'schedule'
        ? {
            updateInterval: (value as CatalogScheduleSelection).interval,
            schedule: (value as CatalogScheduleSelection).schedule
          }
        : { [field]: value }
    ) as CatalogUpdateProfilePatch;
    const controller = new AbortController();
    readControllers.current.add(controller);
    const rememberUnknown = () =>
      unknownIntents.current.set(id, {
        base: expected,
        patch,
        field,
        value,
        before,
        isUndo: Boolean(undoEntry)
      });
    try {
      if (undoEntry) {
        expected = await read(id);
        if (!active()) {
          flow.cancel();
          return obsolete();
        }
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
          return { confirmed: false, error: new TeamApiError('STALE_RESULT', false) };
        }
      }
      flow.stage('save_requested');
      const outcome = await saveCatalogProfile({
        base: expected,
        patch,
        write: () => {
          writeSent = true;
          return client.patchCatalogUpdateProfile!(
            teamId,
            id,
            expected.profile.version,
            patch,
            owner.options(controller.signal)
          );
        },
        signal: controller.signal,
        read: () => read(id),
        canContinue: active,
        onStage: stage => flow.stage(stage)
      });
      if (!active()) {
        flow.cancel();
        return obsolete();
      }
      if (outcome.kind === 'unknown') rememberUnknown();
      else unknownIntents.current.delete(id);
      if (outcome.kind === 'confirmed') {
        if ((snapshotFor(id)?.profile.version ?? 0) > outcome.snapshot.profile.version) {
          failure = new TeamApiError('STALE_RESULT', false);
          setStates(current => ({
            ...current,
            [id]: { phase: 'conflict', field, intended: value, code: 'STALE_RESULT' }
          }));
          setUndo(current =>
            current.map(item => (item.catalogId === id ? { ...item, invalid: true } : item))
          );
          flow.fail('CONFLICT');
          return { confirmed: false, error: failure };
        }

        confirmed = true;
        flow.stage('save_confirmed');
        settle(id, field, value, before, outcome.snapshot, flow, Boolean(undoEntry));
      } else {
        failure = outcome.error;
        if ('snapshot' in outcome && outcome.snapshot) publish(id, outcome.snapshot);
        const phase = outcome.kind === 'rejected' ? 'error' : outcome.kind;
        const code =
          outcome.kind === 'rejected'
            ? outcome.error.code
            : outcome.kind === 'conflict'
              ? 'STALE_RESULT'
              : 'UNKNOWN';
        setStates(current => ({ ...current, [id]: { phase, field, intended: value, code } }));
        flow.fail(
          outcome.kind === 'conflict'
            ? 'CONFLICT'
            : outcome.kind === 'rejected'
              ? outcome.error.code
              : 'UNKNOWN'
        );
      }
    } catch (cause) {
      if (!active()) {
        flow.cancel();
        return obsolete();
      }
      failure = cause;
      if (writeSent) rememberUnknown();
      setStates(current => ({
        ...current,
        [id]: {
          phase: writeSent ? 'unknown' : 'error',
          field,
          intended: value,
          code: writeSent
            ? 'UNKNOWN'
            : cause instanceof TeamApiError
              ? cause.code
              : 'DRIVE_UNAVAILABLE'
        }
      }));
      flow.fail(writeSent ? 'UNKNOWN' : 'READ_FAILED');
    } finally {
      readControllers.current.delete(controller);
      if (active()) locks.current.delete(id);
    }
    return { confirmed, error: confirmed ? undefined : failure };
  };
  const change = async (id: string, field: CatalogField, value: Value, undoEntry?: CatalogUndo) =>
    (await mutate(id, field, value, undoEntry)).confirmed;
  const saveSchedule = async (id: string, selection: CatalogScheduleSelection) => {
    const result = await mutate(id, 'schedule', selection);
    if (!result.confirmed) throw result.error;
  };
  const reconcile = async (id: string) => {
    const epoch = generation.current;
    const active = () => generation.current === epoch && owner.current();
    if (!active() || locks.current.has(id)) return;
    locks.current.add(id);
    const flow = beginCatalogUiFlow('profile', { count: 1 });
    flow.stage('readback_requested');
    try {
      const intent = unknownIntents.current.get(id);
      if (intent) {
        const outcome = await saveCatalogProfile({
          base: intent.base,
          patch: intent.patch,
          readOnly: true,
          read: () => read(id),
          canContinue: active
        });
        if (!active()) {
          flow.cancel();
          return;
        }
        if (
          outcome.kind === 'confirmed' &&
          (snapshotFor(id)?.profile.version ?? 0) <= outcome.snapshot.profile.version
        ) {
          unknownIntents.current.delete(id);
          flow.stage('save_confirmed');
          settle(
            id,
            intent.field,
            intent.value,
            intent.before,
            outcome.snapshot,
            flow,
            intent.isUndo
          );
        } else {
          if ('snapshot' in outcome && outcome.snapshot) publish(id, outcome.snapshot);
          const conflict = outcome.kind === 'conflict' || outcome.kind === 'confirmed';
          if (conflict) {
            unknownIntents.current.delete(id);
            setUndo(current =>
              current.map(item => (item.catalogId === id ? { ...item, invalid: true } : item))
            );
          }
          setStates(current => ({
            ...current,
            [id]: {
              phase: conflict ? 'conflict' : 'unknown',
              field: intent.field,
              intended: intent.value,
              code: conflict ? 'STALE_RESULT' : 'UNKNOWN'
            }
          }));
          flow.fail(conflict ? 'CONFLICT' : 'UNKNOWN');
        }
        return;
      }
      const latest = await read(id);
      if (!active()) {
        flow.cancel();
        return;
      }
      publish(id, latest);
      setStates(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      visibleFlows.current.set(id, flow);
      reload();
    } catch {
      if (active()) flow.fail('READ_FAILED');
      else flow.cancel();
    } finally {
      if (active()) locks.current.delete(id);
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
      if (!owner.current()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [hasPending, owner]);
  return {
    snapshotFor,
    states,
    undo,
    change,
    saveSchedule,
    reconcile,
    blocked,
    hasPending,
    delivered,
    clearUndo: () => setUndo([]),
    undoChange: (entry: CatalogUndo) => change(entry.catalogId, entry.field, entry.before, entry)
  };
}
export type CatalogInlineChanges = ReturnType<typeof useCatalogInlineChanges>;

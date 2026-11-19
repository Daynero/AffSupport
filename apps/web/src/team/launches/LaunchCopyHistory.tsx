import { isLaunchUrl } from '@video-compressor/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { launchCopyMarksApi, type LaunchCopyScope } from '../../api/launch-copy-marks';
import { registerPrivateCache } from '../private-cache-scope';

interface History {
  seen: (field: string, value: string) => boolean;
  remember: (field: string, value: string) => boolean;
}
const Context = createContext<History | null>(null);
export function useLaunchCopyMark(field: string | undefined, value: string) {
  const history = useContext(Context);
  return {
    seen: Boolean(field && history?.seen(field, value)),
    managed: Boolean(field && history),
    remember: () => (field && history ? history.remember(field, value) : true)
  };
}
type Pending = { value: string; copied: boolean; epoch: number };
/**
 * The marks last read for each launch, for as long as the page lives (058).
 *
 * They were read again on every opening of a launch, and until the answer came the result
 * stood unmarked: a quarter of a second in, every copied row turned green and "reset marks"
 * pushed the card down — each time the same launch was opened (owner, beta: "it rebuilds
 * itself on every open"). What was read last is now shown at once and the same read brings
 * it up to date underneath. In memory only, as the marks themselves are, per signed-in
 * person and launch, and dropped with the other private caches when the access changes.
 */
const REMEMBERED_LAUNCHES = 60;
const rememberedMarks = new Map<string, Record<string, string>>();
registerPrivateCache(() => rememberedMarks.clear());
function rememberMarks(identity: string, marks: Record<string, string>) {
  rememberedMarks.delete(identity);
  rememberedMarks.set(identity, marks);
  while (rememberedMarks.size > REMEMBERED_LAUNCHES)
    rememberedMarks.delete(rememberedMarks.keys().next().value!);
}
/** Tests only. */
export function forgetLaunchCopyMarks() {
  rememberedMarks.clear();
}
/** Protected server receipts; copied content exists only in the already-authorized UI's RAM. */
export function LaunchCopyHistory({
  scope,
  lineageId,
  values,
  seedCopies,
  children
}: {
  scope: LaunchCopyScope | null;
  lineageId: string;
  values: Record<string, string>;
  seedCopies?: Record<string, string>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const identity = JSON.stringify([scope?.actorId, scope?.teamId, scope?.launchId, lineageId]);
  const owner = JSON.stringify([scope?.actorId, scope?.teamId, scope?.launchId]);
  const eligible = Object.fromEntries(
    Object.entries(values).filter(([field, value]) => {
      if (!value.length) return false;
      if (field.startsWith('note:'))
        return value.trim().length > 0 && Array.from(value).length <= 8192;
      if (value.length > 8192 || /\p{Cc}/u.test(value)) return false;
      return !['catalog_url', 'advertising_url'].includes(field) || isLaunchUrl(value);
    })
  );
  const signature = JSON.stringify(eligible);
  const current = useRef({ identity, owner, scope, values });
  current.current = { identity, owner, scope, values: eligible };
  const [state, setState] = useState<{ identity: string; marks: Record<string, string> }>(() => ({
    identity,
    marks: (scope && rememberedMarks.get(identity)) || {}
  }));
  const [loading, setLoading] = useState(Boolean(scope));
  const [readFailed, setReadFailed] = useState(false);
  const [readyIdentity, setReadyIdentity] = useState<string | null>(() =>
    scope && rememberedMarks.has(identity) ? identity : null
  );
  const [writeFailed, setWriteFailed] = useState(false);
  const [undo, setUndo] = useState<Record<string, string> | null>(null);
  const queueRef = useRef<{
    identity: string;
    scope: LaunchCopyScope | null;
    pending: Map<string, Pending>;
    busy: boolean;
  } | null>(null);
  if (!queueRef.current || queueRef.current.identity !== identity)
    queueRef.current = { identity, scope, pending: new Map(), busy: false };
  const queue = queueRef.current;
  const pending = { current: queue.pending };
  const mutations = useRef(new Map<string, number>());
  const epoch = useRef(0);
  const request = useRef(0);
  const mounted = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const isCurrent = () => mounted.current && current.current.identity === identity;
  const announce = () => {
    window.dispatchEvent(new CustomEvent('soty:launch-copy-marks', { detail: owner }));
    try {
      channel.current?.postMessage(owner);
    } catch {
      /* Focus read reconciles missing notifications. */
    }
  };
  const load = async () => {
    if (!scope || !isCurrent()) return;
    const seq = ++request.current;
    const began = epoch.current;
    const outstanding = new Set(pending.current.keys());
    const snapshot = { ...current.current.values };
    setLoading(true);
    try {
      const fields = await launchCopyMarksApi.read(scope, snapshot);
      if (!isCurrent() || seq !== request.current) return;
      const fromServer = Object.fromEntries(fields.map(field => [field, snapshot[field]]));
      setState(previous => {
        const next = { ...fromServer };
        if (previous.identity === identity)
          for (const [field, revision] of mutations.current)
            if (outstanding.has(field) || pending.current.has(field) || revision > began) {
              if (Object.hasOwn(previous.marks, field)) next[field] = previous.marks[field];
              else delete next[field];
            }
        for (const [field, change] of pending.current) if (!change.copied) delete next[field];
        return { identity, marks: next };
      });
      setReadFailed(false);
      setReadyIdentity(identity);
    } catch {
      if (isCurrent() && seq === request.current) setReadFailed(true);
    } finally {
      if (isCurrent() && seq === request.current) setLoading(false);
    }
  };
  const flush = async () => {
    if (!queue.scope || queue.busy) return;
    queue.busy = true;
    try {
      while (queue.pending.size) {
        const batch = new Map(pending.current);
        for (const copied of [false, true]) {
          const values = Object.fromEntries(
            [...batch]
              .filter(([, item]) => item.copied === copied)
              .map(([field, item]) => [field, item.value])
          );
          if (Object.keys(values).length)
            await launchCopyMarksApi.write(queue.scope, values, copied);
        }
        for (const [field, item] of batch)
          if (pending.current.get(field)?.epoch === item.epoch) pending.current.delete(field);
        if (isCurrent()) setWriteFailed(false);
        announce();
      }
    } catch {
      if (isCurrent()) setWriteFailed(true);
    } finally {
      queue.busy = false;
    }
  };
  const latest = useRef({ load, flush });
  latest.current = { load, flush };
  useEffect(() => {
    mounted.current = true;
    pending.current.clear();
    mutations.current.clear();
    epoch.current = 0;
    setUndo(null);
    setLoading(Boolean(scope));
    setReadFailed(false);
    setWriteFailed(false);
    const seen = scope ? rememberedMarks.get(identity) : undefined;
    setState({ identity, marks: seen ?? {} });
    if (seen) setReadyIdentity(identity);
    return () => {
      mounted.current = false;
      ++request.current;
    };
  }, [identity]);
  // What a read answered, and every mark made since, is what the next opening starts from.
  useEffect(() => {
    if (scope && state.identity === identity && readyIdentity === identity)
      rememberMarks(identity, state.marks);
  }, [identity, readyIdentity, state, Boolean(scope)]);
  const lastRead = useRef<{ identity: string; revisionId: string | undefined } | null>(null);
  useEffect(() => {
    const initial =
      !lastRead.current ||
      lastRead.current.identity !== identity ||
      lastRead.current.revisionId !== scope?.revisionId;
    lastRead.current = { identity, revisionId: scope?.revisionId };
    if (initial) {
      void latest.current.load();
      return;
    }
    // Manual edits invalidate the visual mark immediately; debounce protected reads while typing.
    const timer = setTimeout(() => void latest.current.load(), 250);
    return () => clearTimeout(timer);
  }, [identity, signature, scope?.revisionId]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void latest.current.load();
    };
    const event = (e: Event) => {
      if ((e as CustomEvent).detail === owner) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('soty:launch-copy-marks', event);
    document.addEventListener('visibilitychange', refresh);
    if (scope && typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('soty-launch-copy-marks');
      channel.current.onmessage = e => {
        if (e.data === owner) refresh();
      };
    }
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('soty:launch-copy-marks', event);
      document.removeEventListener('visibilitychange', refresh);
      channel.current?.close();
      channel.current = null;
    };
  }, [identity, owner, Boolean(scope)]);
  const seen = (field: string, value: string) =>
    state.identity === identity && state.marks[field] === value;
  const apply = (values: Record<string, string>, copied: boolean) => {
    if (current.current.identity !== identity) return;
    for (const [field, value] of Object.entries(values)) {
      const revision = ++epoch.current;
      mutations.current.set(field, revision);
      if (scope) pending.current.set(field, { value, copied, epoch: revision });
    }
    if (mounted.current)
      setState(previous => {
        const marks = previous.identity === identity ? { ...previous.marks } : {};
        for (const [field, value] of Object.entries(values)) {
          if (copied) marks[field] = value;
          else delete marks[field];
        }
        return { identity, marks };
      });
    void flush();
  };
  const seedSignature = JSON.stringify(seedCopies ?? {});
  const seedApply = useRef(apply);
  seedApply.current = apply;
  useEffect(() => {
    const matching = Object.fromEntries(
      Object.entries(seedCopies ?? {}).filter(
        ([field, value]) => current.current.values[field] === value
      )
    );
    if (Object.keys(matching).length) seedApply.current(matching, true);
  }, [identity, seedSignature]);
  const visible = eligible;
  const completed = Object.fromEntries(
    Object.entries(visible).filter(([field, value]) => seen(field, value))
  );
  const availableUndo = state.identity === identity ? undo : null;
  const count = Object.keys(completed).length;
  const total = Object.keys(visible).length;
  return (
    <Context.Provider
      value={{
        seen,
        remember: (field, value) => {
          if (current.current.identity !== identity) return false;
          if (mounted.current) setUndo(null);
          apply({ [field]: value }, true);
          return true;
        }
      }}
    >
      {total > 0 && (
        <div className="launch-copy-progress">
          <span
            className="text-caption text-ink-muted"
            aria-live="polite"
            title={t('launchesCopyMarksPersonal')}
          >
            {loading && readyIdentity !== identity
              ? t('launchesCopyMarksLoading')
              : readFailed
                ? t('launchesCopyMarksReadFailed')
                : t('launchesCopyProgress', { count, total })}
          </span>
          <div className="flex items-center gap-2">
            {(readFailed || writeFailed) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void latest.current.flush();
                  void latest.current.load();
                }}
              >
                {t('launchesCopyMarksRetry')}
              </Button>
            )}
            {availableUndo ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const restore = Object.fromEntries(
                    Object.entries(availableUndo).filter(
                      ([field, value]) => current.current.values[field] === value
                    )
                  );
                  setUndo(null);
                  apply(restore, true);
                }}
              >
                {t('launchesCopyMarksUndo')}
              </Button>
            ) : (
              count > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUndo(completed);
                    apply(completed, false);
                  }}
                >
                  <RotateCcw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t('launchesCopyMarksReset')}
                </Button>
              )
            )}
          </div>
          {writeFailed && (
            <span className="text-caption text-warning-text" role="status">
              {t('launchesCopyMarksWriteFailed')}
            </span>
          )}
        </div>
      )}
      {children}
    </Context.Provider>
  );
}

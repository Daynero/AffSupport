/**
 * The texts of one transcript (063): the original and every translation of it, with the ones in
 * flight followed live. Shared by the space's video text and the local transcriber, which differ
 * only in where the original comes from and where translations are filed.
 */
import {
  groupTranslationUnits,
  translationFingerprint,
  translationUnits,
  type TranscriptTranslation,
  type TranslationAllowance,
  type TranslationFailureCode,
  type TranslationStreamEvent
} from '@video-compressor/shared';
import { parseAiCreditsStatus, translationPrice } from '@video-compressor/shared';
import { refreshCredits, setCredits } from '../credits/store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TeamApiError } from '../api/team';
import { translationClient, type TranslationClient, type TranslationSource } from './api';
import { trackTranslation } from './analytics';

export type VariantSource =
  | {
      scope: 'team_video';
      teamId: string;
      videoId: string;
      language: string | null;
      segments: readonly string[];
      /** The text as stored, copied verbatim; segments are its normalized lines. */
      rawText?: string;
    }
  | {
      scope: 'personal';
      documentKey: string;
      language: string | null;
      segments: readonly string[];
    };

export interface OriginalVariant {
  key: 'original';
  kind: 'original';
  language: string | null;
  segments: readonly string[];
  rawText?: string;
}

export interface TranslationVariant {
  key: string;
  kind: 'translation';
  language: string;
  translationId: string;
  status: 'ready' | 'processing' | 'failed';
  segments: readonly string[] | null;
  completedSegments: number;
  totalSegments: number;
  failureCode: TranslationFailureCode | null;
  /** The text it was made from. */
  sourceFingerprint: string | null;
  /** Made from an earlier version of the original text. */
  stale: boolean;
  startedAt: number;
}

export type TextVariant = OriginalVariant | TranslationVariant;

export type StartOutcome =
  | { ok: true; translationId: string; reused: boolean }
  | {
      ok: false;
      code: string;
      details?: Record<string, string | number | boolean | null>;
    };

const RECENTS_KEY = 'soty.translation.recentTargets';

export function readRecentTargets(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((code): code is string => typeof code === 'string').slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function rememberTarget(code: string): void {
  try {
    const next = [code, ...readRecentTargets().filter(item => item !== code)].slice(0, 6);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // A convenience only: a private window simply forgets.
  }
}

function toVariant(translation: TranscriptTranslation): TranslationVariant {
  return {
    key: `translation:${translation.targetLanguage}`,
    kind: 'translation',
    language: translation.targetLanguage,
    translationId: translation.id,
    status:
      translation.status === 'completed'
        ? 'ready'
        : translation.status === 'processing'
          ? 'processing'
          : 'failed',
    segments: translation.segments,
    completedSegments: translation.completedSegments,
    totalSegments: translation.totalSegments,
    failureCode: translation.failureCode,
    sourceFingerprint: translation.sourceFingerprint,
    stale: false,
    startedAt: Date.parse(translation.createdAt)
  };
}

/**
 * One entry per language: a finished result wins over a failure, and an attempt in flight is
 * shown beside the finished one it is about to replace (the finished one stays readable).
 */
function mergeByLanguage(list: TranslationVariant[]): {
  shown: TranslationVariant[];
  running: Map<string, TranslationVariant>;
} {
  const shown = new Map<string, TranslationVariant>();
  const running = new Map<string, TranslationVariant>();
  for (const variant of [...list].sort((a, b) => a.startedAt - b.startedAt)) {
    if (variant.status === 'processing') {
      running.set(variant.language, variant);
      if (!shown.has(variant.language) || shown.get(variant.language)!.status === 'failed') {
        shown.set(variant.language, variant);
      }
      continue;
    }
    const current = shown.get(variant.language);
    if (!current || current.status !== 'ready' || variant.status === 'ready') {
      if (!(current?.status === 'processing' && variant.status === 'failed')) {
        shown.set(variant.language, variant);
      }
    }
  }
  return { shown: [...shown.values()], running };
}

export interface TextVariantsState {
  original: OriginalVariant;
  translations: TranslationVariant[];
  /** Attempts in flight by language, including ones replacing a finished translation. */
  running: Map<string, TranslationVariant>;
  allowance: TranslationAllowance | null;
  allowanceError: boolean;
  units: number;
  loading: boolean;
  start(targetLanguage: string): Promise<StartOutcome>;
  /** Deletes the translation of that language; false when the server refused. */
  remove(language: string): Promise<boolean>;
  refreshAllowance(): Promise<void>;
}

export function useTextVariants(
  source: VariantSource | null,
  client: TranslationClient = translationClient
): TextVariantsState {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [items, setItems] = useState<TranslationVariant[]>([]);
  const [allowance, setAllowance] = useState<TranslationAllowance | null>(null);
  const [allowanceError, setAllowanceError] = useState(false);
  const [loading, setLoading] = useState(true);
  const watches = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);

  const scopeKey = source
    ? source.scope === 'team_video'
      ? `team:${source.teamId}:${source.videoId}`
      : `personal:${source.documentKey}`
    : null;
  const segments = source?.segments;
  const segmentsKey = useMemo(() => (segments ? segments.join('\n') : ''), [segments]);
  const units = useMemo(() => (segments ? translationUnits(segments) : 0), [segments]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of watches.current.values()) controller.abort();
      watches.current.clear();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setFingerprint(null);
    if (!segments || segments.length === 0) return;
    void translationFingerprint(segments).then(value => {
      if (active) setFingerprint(value);
    });
    return () => {
      active = false;
    };
  }, [segmentsKey]);

  const refreshAllowance = useCallback(async () => {
    try {
      const value = await client.allowance();
      if (mounted.current) {
        setAllowance(value);
        setAllowanceError(false);
      }
    } catch {
      if (mounted.current) setAllowanceError(true);
    }
  }, [client]);

  const upsert = useCallback((translation: TranscriptTranslation) => {
    setItems(previous => {
      const next = previous.filter(item => item.translationId !== translation.id);
      const variant = toVariant(translation);
      // A finished result replaces the earlier finished one of its language.
      const pruned =
        variant.status === 'ready'
          ? next.filter(
              item => !(item.language === variant.language && item.status !== 'processing')
            )
          : next;
      return [...pruned, variant];
    });
  }, []);

  const follow = useCallback(
    (
      translationId: string,
      meta: { language: string; scope: VariantSource['scope']; started: number }
    ) => {
      if (watches.current.has(translationId)) return;
      const controller = new AbortController();
      watches.current.set(translationId, controller);
      let finished = false;
      const onEvent = (event: TranslationStreamEvent) => {
        if (!mounted.current) return;
        if (event.type === 'progress') {
          setItems(previous =>
            previous.map(item =>
              item.translationId === translationId
                ? {
                    ...item,
                    completedSegments: Math.max(item.completedSegments, event.completedSegments),
                    totalSegments: event.totalSegments
                  }
                : item
            )
          );
          return;
        }
        finished = true;
        if (event.type === 'done') {
          upsert(event.translation);
          trackTranslation({
            action: 'completed',
            scope: meta.scope,
            targetLanguage: meta.language,
            translationId,
            units: event.translation.units,
            durationMs: Math.max(0, Date.now() - meta.started)
          });
        } else {
          setItems(previous =>
            previous.map(item =>
              item.translationId === translationId
                ? { ...item, status: 'failed', failureCode: event.code }
                : item
            )
          );
          trackTranslation({
            action: 'failed',
            scope: meta.scope,
            targetLanguage: meta.language,
            translationId,
            code: event.code
          });
        }
        void refreshAllowance();
      };
      void client
        .watch(translationId, onEvent, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          watches.current.delete(translationId);
          // The stream may end before the attempt does (watch limit, a dropped connection).
          // It is opened again when the page is visible; a hidden page waits for visibility.
          if (!finished && mounted.current && !controller.signal.aborted) {
            if (document.visibilityState === 'visible') {
              window.setTimeout(() => {
                if (mounted.current) follow(translationId, meta);
              }, 1_500);
            }
          }
        });
    },
    [client, refreshAllowance, upsert]
  );

  // Load what exists for this text.
  useEffect(() => {
    if (!source || !scopeKey) return;
    if (source.scope === 'personal' && !fingerprint) return;
    let active = true;
    setLoading(true);
    const load =
      source.scope === 'team_video'
        ? client.listForVideo(source.teamId, source.videoId)
        : client.listPersonal(source.documentKey, fingerprint!);
    void load
      .then(list => {
        if (!active) return;
        setItems(list.map(toVariant));
        for (const item of list) {
          if (item.status === 'processing') {
            follow(item.id, {
              language: item.targetLanguage,
              scope: source.scope,
              started: Date.parse(item.createdAt)
            });
          }
        }
      })
      .catch(() => {
        if (active) setItems([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void refreshAllowance();
    return () => {
      active = false;
    };
  }, [scopeKey, source?.scope === 'personal' ? fingerprint : null]);

  // A stream that ended while the page was hidden is opened again when it is shown.
  useEffect(() => {
    if (!source) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      for (const item of items) {
        if (item.status === 'processing' && !watches.current.has(item.translationId)) {
          follow(item.translationId, {
            language: item.language,
            scope: source.scope,
            started: item.startedAt
          });
        }
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [follow, items, source]);

  const start = useCallback(
    async (targetLanguage: string): Promise<StartOutcome> => {
      if (!source) return { ok: false, code: 'INVALID_INPUT' };
      const request: TranslationSource =
        source.scope === 'team_video'
          ? { scope: 'team_video', teamId: source.teamId, videoId: source.videoId }
          : {
              scope: 'personal',
              documentKey: source.documentKey,
              sourceLanguage: source.language,
              segments: [...source.segments]
            };
      trackTranslation({ action: 'requested', scope: source.scope, targetLanguage, units });
      try {
        const started = await client.start(
          targetLanguage,
          request,
          translationPrice(units, targetLanguage)
        );
        rememberTarget(targetLanguage);
        if (started.allowance) setAllowance(started.allowance);
        const credits = parseAiCreditsStatus(started.credits);
        if (credits) setCredits(credits);
        else void refreshCredits();
        if (started.status === 'completed') {
          upsert(await client.get(started.translationId));
          trackTranslation({
            action: 'reused',
            scope: source.scope,
            targetLanguage,
            translationId: started.translationId
          });
        } else {
          const now = Date.now();
          setItems(previous =>
            previous.some(item => item.translationId === started.translationId)
              ? previous
              : [
                  ...previous,
                  {
                    key: `translation:${targetLanguage}`,
                    kind: 'translation',
                    language: targetLanguage,
                    translationId: started.translationId,
                    status: 'processing',
                    segments: null,
                    completedSegments: 0,
                    totalSegments: Math.max(1, groupTranslationUnits(source.segments).length),
                    failureCode: null,
                    sourceFingerprint: fingerprint,
                    stale: false,
                    startedAt: now
                  }
                ]
          );
          trackTranslation({
            action: started.reused ? 'reused' : 'started',
            scope: source.scope,
            targetLanguage,
            translationId: started.translationId,
            units: started.units
          });
          follow(started.translationId, {
            language: targetLanguage,
            scope: source.scope,
            started: now
          });
        }
        return { ok: true, translationId: started.translationId, reused: started.reused };
      } catch (error) {
        const code = error instanceof TeamApiError ? error.code : 'TEAM_TRANSPORT_UNAVAILABLE';
        trackTranslation({ action: 'blocked', scope: source.scope, targetLanguage, units, code });
        if (code === 'TRANSLATION_ALLOWANCE_EXCEEDED') void refreshAllowance();
        if (
          code === 'INSUFFICIENT_CREDITS' ||
          code === 'AI_MONTH_EXHAUSTED' ||
          code === 'PRICE_CHANGED'
        )
          void refreshCredits();
        return {
          ok: false,
          code,
          ...(error instanceof TeamApiError && error.details ? { details: error.details } : {})
        };
      }
    },
    [client, fingerprint, follow, refreshAllowance, source, units, upsert]
  );

  // Staleness follows the current text: a translation of another text is marked, not hidden.
  const remove = useCallback(
    async (language: string): Promise<boolean> => {
      const target = items.find(item => item.language === language && item.status !== 'processing');
      if (!target || !source) return false;
      try {
        await client.remove(target.translationId);
      } catch {
        return false;
      }
      setItems(previous =>
        previous.filter(item => item.language !== language || item.status === 'processing')
      );
      trackTranslation({
        action: 'deleted',
        scope: source.scope,
        targetLanguage: language,
        translationId: target.translationId
      });
      return true;
    },
    [client, items, source]
  );

  const merged = useMemo(
    () =>
      mergeByLanguage(
        items.map(item => ({
          ...item,
          stale:
            fingerprint !== null &&
            item.sourceFingerprint !== null &&
            item.sourceFingerprint !== fingerprint
        }))
      ),
    [fingerprint, items]
  );

  const original: OriginalVariant = useMemo(
    () => ({
      key: 'original',
      kind: 'original',
      language: source?.language ?? null,
      segments: source?.segments ?? [],
      ...(source?.scope === 'team_video' && source.rawText !== undefined
        ? { rawText: source.rawText }
        : {})
    }),
    [source]
  );

  return {
    original,
    translations: merged.shown,
    running: merged.running,
    allowance,
    allowanceError,
    units,
    loading,
    start,
    remove,
    refreshAllowance
  };
}

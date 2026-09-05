import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptionTranslationSummary,
  TranslationDocument
} from '@video-compressor/shared';
import {
  transcriptionTranslate,
  transcriptionTranslation,
  transcriptionTranslationCancel
} from '../api/client';
import type { Language } from '../i18n';
import { defaultTranslationTarget } from './language';

/** How often at most a still-running translation's segments are fetched. */
const PARTIAL_FETCH_MS = 2_000;

export type TranslationError = 'failed' | 'unavailable' | null;

/**
 * The translation column's state: which language, what has arrived, what is in flight.
 *
 * Opening the viewer JOINS the automatic translation the list already started instead of
 * superseding it — the shared target resolver makes both sides ask for the same language —
 * so a running translation is never restarted and a finished one resolves at once. The live
 * `job` prop carries status and progress over the event stream; nothing here polls.
 */
export function useTranslationFollow(options: {
  job: TranscriptionJob;
  document: TranscriptionDocument | null;
  language: Language;
  translatorPresent: boolean;
}): {
  target: string;
  /** Picks a language; a translation validated earlier in this session shows at once. */
  chooseTarget: (code: string) => void;
  translation: TranslationDocument | null;
  /** The live summary for the chosen target, from the job over the event stream. */
  summary: TranscriptionTranslationSummary | null;
  translating: boolean;
  requesting: boolean;
  error: TranslationError;
  retry: () => void;
  cancel: () => Promise<void>;
} {
  const { job, document, language, translatorPresent } = options;
  const [target, setTarget] = useState<string>(() => {
    const sourceLanguage = job.detectedLanguage ?? job.requestedLanguage ?? 'auto';
    const sourceBase = sourceLanguage.replaceAll('_', '-').split('-')[0].toLowerCase();
    const selected = job.translation?.targetLanguage;
    if (selected && selected.replaceAll('_', '-').split('-')[0].toLowerCase() !== sourceBase) {
      return selected;
    }
    return defaultTranslationTarget(sourceLanguage, language);
  });
  const [translation, setTranslation] = useState<TranslationDocument | null>(null);
  /** True only while the ensure/join POST is in flight (covers the SSE gap). */
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<TranslationError>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const generation = useRef(0);
  const validated = useRef(new Map<string, TranslationDocument>());
  const lastDistinctTarget = useRef<string | null>(null);
  const translatorWasPresent = useRef(translatorPresent);

  // A new run of the file: everything remembered about the old one goes.
  useEffect(() => {
    validated.current.clear();
    setTranslation(null);
  }, [job.id, job.finishedAt]);

  const summary =
    job.translation && job.translation.targetLanguage.toLowerCase() === target.toLowerCase()
      ? job.translation
      : null;
  const summaryTranslating = summary?.status === 'queued' || summary?.status === 'processing';
  const translating = !error && (requesting || summaryTranslating);

  // Ensure/join backend work for the chosen target.
  useEffect(() => {
    if (!document) return;
    const source = document.sourceLanguage.split('-')[0].toLowerCase();
    if (source === target.split('-')[0].toLowerCase()) {
      setTranslation(null);
      setRequesting(false);
      setError(null);
      return;
    }
    // A response validated by the backend in this session renders instantly; the POST
    // below still revalidates model/cache versions.
    const known = validated.current.get(target);
    if (known) {
      setTranslation(known);
      setError(null);
    }
    const gen = ++generation.current;
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${job.id}-${gen}-${Date.now()}`;
    let active = true;
    setRequesting(!known);
    setError(null);
    void transcriptionTranslate(job.id, target, requestId)
      .then(result => {
        if (!active || generation.current !== gen) return;
        if (result.status === 'completed') {
          validated.current.set(result.targetLanguage, result);
          setTranslation(result);
        } else if (result.segments.length) {
          // Partials persisted by a still-running translation render right away.
          setTranslation(result);
        }
      })
      .catch(failure => {
        if (!active || generation.current !== gen) return;
        const message = failure instanceof Error ? failure.message : '';
        setError(message.includes('TRANSLATOR_UNAVAILABLE') ? 'unavailable' : 'failed');
      })
      .finally(() => {
        if (active && generation.current === gen) setRequesting(false);
      });
    return () => {
      active = false;
    };
  }, [document, target, job.id, retryNonce]);

  // Follow the live summary: fetch newly streamed segments while the backend translates,
  // the final document on completion, and surface failures. The count already fetched is
  // remembered so a summary that runs ahead of the sidecar cannot refetch in a loop, and
  // partial fetches wait for the sidecar's own two-second cadence — asking after every
  // segment fetched the whole growing document once per segment.
  const summaryStatus = summary?.status ?? null;
  const summaryCompletedSegments = summary?.completedSegments ?? 0;
  const fetchedSegments = useRef<{ target: string; count: number }>({ target: '', count: -1 });
  const lastPartialFetch = useRef(0);
  const translationRef = useRef(translation);
  translationRef.current = translation;
  useEffect(() => {
    if (!document || !summaryStatus) return;
    if (summaryStatus === 'failed') {
      // While the retry POST is in flight the summary may still say failed.
      if (!requesting) setError('failed');
      return;
    }
    if (summaryStatus === 'unavailable') {
      setError('unavailable');
      return;
    }
    const current = translationRef.current;
    const matching =
      current && current.targetLanguage.toLowerCase() === target.toLowerCase() ? current : null;
    const wantsFinal = summaryStatus === 'completed' && matching?.status !== 'completed';
    const already = fetchedSegments.current.target === target ? fetchedSegments.current.count : -1;
    const wantsPartial =
      summaryStatus === 'processing' &&
      matching?.status !== 'completed' &&
      summaryCompletedSegments > (matching?.segments.length ?? 0) &&
      summaryCompletedSegments !== already;
    if (!wantsFinal && !wantsPartial) return;
    fetchedSegments.current = {
      target,
      count: wantsFinal ? Number.MAX_SAFE_INTEGER : summaryCompletedSegments
    };
    const gen = generation.current;
    let active = true;
    const controller = new AbortController();
    const wait = wantsFinal
      ? 0
      : Math.max(0, PARTIAL_FETCH_MS - (Date.now() - lastPartialFetch.current));
    const timer = window.setTimeout(() => {
      if (!active) return;
      if (!wantsFinal) lastPartialFetch.current = Date.now();
      transcriptionTranslation(job.id, target, controller.signal)
        .then(result => {
          if (!active || generation.current !== gen) return;
          if (result.targetLanguage.toLowerCase() !== target.toLowerCase()) return;
          if (result.status === 'completed') {
            validated.current.set(result.targetLanguage, result);
            setTranslation(result);
            setError(null);
          } else if (result.segments.length) {
            setTranslation(result);
          }
        })
        .catch(() => {
          // Progress keeps flowing over SSE; the next change retries the fetch.
          fetchedSegments.current = { target: '', count: -1 };
        });
    }, wait);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [document, summaryStatus, summaryCompletedSegments, requesting, target, job.id]);

  // A target that turns out to be the source language is replaced by the default.
  useEffect(() => {
    if (!document) return;
    const source = document.sourceLanguage.split('-')[0].toLowerCase();
    setTarget(current => {
      if (current.split('-')[0].toLowerCase() !== source) return current;
      return defaultTranslationTarget(
        document.sourceLanguage,
        language,
        lastDistinctTarget.current
      );
    });
  }, [document, language]);

  // Once the translation model finishes installing, resume translation automatically.
  useEffect(() => {
    if (!translatorWasPresent.current && translatorPresent) setRetryNonce(nonce => nonce + 1);
    translatorWasPresent.current = translatorPresent;
  }, [translatorPresent]);

  const chooseTarget = useCallback((code: string) => {
    lastDistinctTarget.current = code;
    const known = validated.current.get(code);
    if (known) {
      setTranslation(known);
      setError(null);
    }
    setTarget(code);
  }, []);
  const retry = useCallback(() => setRetryNonce(nonce => nonce + 1), []);
  const cancel = useCallback(async () => {
    try {
      await transcriptionTranslationCancel(job.id);
    } catch {
      // Status keeps streaming over SSE; a failed cancel simply changes nothing.
    }
  }, [job.id]);

  return {
    target,
    chooseTarget,
    translation,
    summary,
    translating,
    requesting,
    error,
    retry,
    cancel
  };
}

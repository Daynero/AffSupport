import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptionMediaPreview } from '@video-compressor/shared';
import {
  transcriptionMediaCancel,
  transcriptionMediaPrepare,
  transcriptionMediaStatus
} from '../api/client';

const FAILED: TranscriptionMediaPreview = {
  state: 'failed',
  variant: null,
  progress: null,
  hasVideo: null,
  mimeType: null,
  error: 'PREVIEW_FAILED'
};

/** The first poll is quick because a compatible file is ready at once; later ones back off. */
const POLL_INITIAL_MS = 400;
const POLL_MAX_MS = 2_000;

/**
 * The player's source, prepared on demand.
 *
 * A browser-compatible file streams as it is; anything else is transcoded to a cached
 * proxy first, and while that runs the status is polled — with a backoff, because a
 * ten-minute transcode polled three times a second is two thousand requests that all say
 * "still going".
 */
export function useMediaPreview(jobId: string): {
  preview: TranscriptionMediaPreview | null;
  prepare: () => Promise<void>;
  cancel: () => Promise<void>;
  /** The element could not play what it was given; the retry path takes over. */
  fail: () => void;
} {
  const [preview, setPreview] = useState<TranscriptionMediaPreview | null>(null);
  const jobRef = useRef(jobId);
  useEffect(() => {
    jobRef.current = jobId;
    setPreview(null);
  }, [jobId]);

  useEffect(() => {
    if (preview?.state !== 'preparing') return;
    let active = true;
    const controller = new AbortController();
    let delay = POLL_INITIAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (!active) return;
      try {
        const status = await transcriptionMediaStatus(jobId, controller.signal);
        if (!active) return;
        setPreview(status);
        if (status.state !== 'preparing') return;
      } catch {
        if (active) setPreview(FAILED);
        return;
      }
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
      timer = setTimeout(() => void poll(), delay);
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [preview?.state, jobId]);

  const prepare = useCallback(async () => {
    const id = jobRef.current;
    try {
      const status = await transcriptionMediaPrepare(id);
      if (jobRef.current === id) setPreview(status);
    } catch {
      if (jobRef.current === id) setPreview(FAILED);
    }
  }, []);

  const cancel = useCallback(async () => {
    await transcriptionMediaCancel(jobRef.current).catch(() => {});
    setPreview(current =>
      current ? { ...current, state: 'checking', progress: null, error: null } : current
    );
  }, []);

  const fail = useCallback(() => setPreview(FAILED), []);

  return { preview, prepare, cancel, fail };
}

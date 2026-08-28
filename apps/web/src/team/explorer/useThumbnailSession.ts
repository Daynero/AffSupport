import { useEffect, useState } from 'react';
import type { ThumbnailSession } from '@video-compressor/shared';

/**
 * One thumbnail session per space visit (011, FR-014): minted once, held in
 * memory only, refreshed a minute before it runs out. Every tile in every grid
 * shares it, so two hundred rows cost one mint rather than two hundred grants.
 */
export interface ThumbnailSessionClient {
  mintThumbnailSession: (teamId: string) => Promise<ThumbnailSession>;
  thumbnailUrl: (session: ThumbnailSession, materialId: string) => string;
}

const REFRESH_MARGIN_MS = 60_000;
const sessions = new Map<string, { promise: Promise<ThumbnailSession>; expiresAt: number }>();

function expiryOf(session: ThumbnailSession): number {
  const parsed = Date.parse(session.expiresAt);
  return Number.isNaN(parsed) ? Date.now() + 5 * 60_000 : parsed;
}

/** Shared across components: the same space never mints twice at once. */
export function getThumbnailSession(
  client: ThumbnailSessionClient,
  teamId: string
): Promise<ThumbnailSession> {
  const cached = sessions.get(teamId);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.promise;
  // A client without a mint (an older shell, a partial test double) is an
  // absent session, never a thrown effect.
  const promise = Promise.resolve()
    .then(() => client.mintThumbnailSession(teamId))
    .then(session => {
      sessions.set(teamId, { promise: Promise.resolve(session), expiresAt: expiryOf(session) });
      return session;
    })
    .catch(error => {
      sessions.delete(teamId);
      throw error;
    });
  sessions.set(teamId, { promise, expiresAt: Date.now() + 30_000 });
  return promise;
}

export function clearThumbnailSessions(): void {
  sessions.clear();
}

export function useThumbnailSession(input: {
  teamId: string;
  client: ThumbnailSessionClient;
  enabled?: boolean;
}): ThumbnailSession | null {
  const { teamId, client, enabled = true } = input;
  const [session, setSession] = useState<ThumbnailSession | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSession(null);
      return;
    }
    let active = true;
    let timer: number | null = null;
    const refresh = () => {
      void getThumbnailSession(client, teamId)
        .then(value => {
          if (!active) return;
          setSession(value);
          const wait = Math.max(5_000, expiryOf(value) - REFRESH_MARGIN_MS - Date.now());
          timer = window.setTimeout(refresh, wait);
        })
        .catch(() => {
          if (!active) return;
          setSession(null);
          timer = window.setTimeout(refresh, 30_000);
        });
    };
    refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client, enabled, teamId]);

  return session;
}

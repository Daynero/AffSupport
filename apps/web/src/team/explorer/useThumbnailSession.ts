import { withReadDeadline } from '../readCoordinator';
import {
  privateCacheEpoch,
  privateClientId,
  privateCacheSuperseded,
  registerPrivateCache,
  usePrivateCacheEpoch
} from '../private-cache-scope';
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
  teamId: string,
  source: object = client
): Promise<ThumbnailSession> {
  const epoch = privateCacheEpoch();
  const key = `${epoch}:${privateClientId(source)}:${teamId}`;
  const cached = sessions.get(key);
  if (
    cached &&
    (cached.expiresAt === Infinity || cached.expiresAt - REFRESH_MARGIN_MS > Date.now())
  )
    return cached.promise;
  // A client without a mint (an older shell, a partial test double) is an
  // absent session, never a thrown effect.
  const promise = Promise.resolve()
    .then(() => {
      if (epoch !== privateCacheEpoch()) throw privateCacheSuperseded();
      return withReadDeadline(
        () => client.mintThumbnailSession(teamId),
        new AbortController().signal
      );
    })
    .then(session => {
      if (epoch !== privateCacheEpoch() || sessions.get(key)?.promise !== promise)
        throw privateCacheSuperseded();
      sessions.set(key, { promise: Promise.resolve(session), expiresAt: expiryOf(session) });
      while (sessions.size > 20) sessions.delete(sessions.keys().next().value!);
      return session;
    })
    .catch(error => {
      if (sessions.get(key)?.promise === promise) sessions.delete(key);
      throw error;
    });
  sessions.set(key, { promise, expiresAt: Infinity });
  while (sessions.size > 20) sessions.delete(sessions.keys().next().value!);
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
  const epoch = usePrivateCacheEpoch();
  const scope = `${epoch}:${privateClientId(client)}:${teamId}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; session: ThumbnailSession } | null>(
    null
  );

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    let active = true;
    let timer: number | null = null;
    const refresh = () => {
      void getThumbnailSession(client, teamId)
        .then(value => {
          if (!active) return;
          setSnapshot({ scope, session: value });
          const wait = Math.max(5_000, expiryOf(value) - REFRESH_MARGIN_MS - Date.now());
          timer = window.setTimeout(refresh, wait);
        })
        .catch(() => {
          if (!active) return;
          setSnapshot(null);
          timer = window.setTimeout(refresh, 30_000);
        });
    };
    refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client, enabled, teamId, scope]);

  return enabled && snapshot?.scope === scope ? snapshot.session : null;
}

registerPrivateCache(clearThumbnailSessions);

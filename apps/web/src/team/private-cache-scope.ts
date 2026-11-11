import { useSyncExternalStore } from 'react';

let scope = '';
let actorId: string | null = null;
let epoch = 0;
// Changes only when the signed-in account changes (including sign-out), never on
// an access-scope refresh for the same person.
let actorEpoch = 0;
const clearers = new Set<() => void>();
const subscribers = new Set<() => void>();
const identities = new WeakMap<object, number>();
let identity = 0;

/** Called before rendering private children, using confirmed actor and access state. */
export function setPrivateCacheScope(actor: string | null, access: string): void {
  const next = JSON.stringify([actor, access]);
  if (next === scope) return;
  scope = next;
  if (actor !== actorId) actorEpoch += 1;
  actorId = actor;
  epoch += 1;
  for (const clear of clearers) clear();
  // Do not synchronously update a mounted child while its parent renders.
  queueMicrotask(() => {
    for (const notify of subscribers) notify();
  });
}
export const privateCacheActor = () => actorId;
export const privateCacheEpoch = () => epoch;
/** For work that must never complete under another account, but must survive a
 * same-person access refresh (realtime membership signal, teams re-read): a
 * long request owned by one actor keeps going while that actor stays signed in. */
export const privateCacheActorEpoch = () => actorEpoch;
export function registerPrivateCache(clear: () => void): void {
  clearers.add(clear);
}
export function privateClientId(client: object): number {
  let id = identities.get(client);
  if (id === undefined) {
    id = ++identity;
    identities.set(client, id);
  }
  return id;
}
export function usePrivateCacheEpoch(): number {
  return useSyncExternalStore(
    notify => {
      subscribers.add(notify);
      return () => {
        subscribers.delete(notify);
      };
    },
    privateCacheEpoch,
    privateCacheEpoch
  );
}
export function privateCacheSuperseded(): Error {
  return Object.assign(new Error('PRIVATE_CACHE_SUPERSEDED'), { name: 'AbortError' });
}

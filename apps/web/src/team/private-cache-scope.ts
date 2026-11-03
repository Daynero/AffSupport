import { useSyncExternalStore } from 'react';

let scope = '';
let epoch = 0;
const clearers = new Set<() => void>();
const subscribers = new Set<() => void>();
const identities = new WeakMap<object, number>();
let identity = 0;

/** Called before rendering private children, using confirmed actor and access state. */
export function setPrivateCacheScope(actor: string | null, access: string): void {
  const next = JSON.stringify([actor, access]);
  if (next === scope) return;
  scope = next;
  epoch += 1;
  for (const clear of clearers) clear();
  // Do not synchronously update a mounted child while its parent renders.
  queueMicrotask(() => {
    for (const notify of subscribers) notify();
  });
}
export const privateCacheEpoch = () => epoch;
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

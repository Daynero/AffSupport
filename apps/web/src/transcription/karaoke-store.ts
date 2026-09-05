import { useSyncExternalStore } from 'react';
import type { CharRange } from './alignment';

/** The karaoke word under the playhead, as a source-segment character range. */
export interface ActiveWord {
  segmentId: string;
  wordId: string;
  range: CharRange;
}

type Listener = () => void;

/**
 * Where the active word lives, outside React's render tree.
 *
 * The playhead moves sixty times a second and the word under it changes a few times a
 * second. Holding that in the viewer's state re-rendered the whole viewer — both columns,
 * thousands of segments' props — on every word. Here the source column marks the word
 * straight in the DOM, and only the one translated segment that mirrors it subscribes and
 * re-renders; every other segment never hears about it.
 */
export class KaraokeStore {
  private active: ActiveWord | null = null;
  private readonly listeners = new Set<Listener>();

  get(): ActiveWord | null {
    return this.active;
  }

  set(next: ActiveWord | null): void {
    if (next === this.active) return;
    if (next && this.active && next.wordId === this.active.wordId) return;
    this.active = next;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const NONE: ActiveWord | null = null;

/**
 * The active word when it belongs to this segment, and null otherwise.
 *
 * `useSyncExternalStore` compares snapshots by identity, so a segment whose answer stays
 * "not mine" is never re-rendered — the selector returns the same `null` every time.
 */
export function useActiveWordInSegment(store: KaraokeStore, segmentId: string): ActiveWord | null {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => {
      const active = store.get();
      return active && active.segmentId === segmentId ? active : NONE;
    },
    () => NONE
  );
}

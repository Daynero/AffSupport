/** Optional only for content-free test trackers; the production tracker always exposes its actor. */
export interface AnalyticsActorSource {
  journalContext?: () => { userId: string | null };
}

/** Retain an attempt's original actor without adding that identity to event properties. */
export function captureAnalyticsActor(source: AnalyticsActorSource): () => boolean {
  if (!source.journalContext) return () => true;
  let owner: string | null;
  try {
    owner = source.journalContext().userId;
  } catch {
    return () => false;
  }
  return () => {
    try {
      return source.journalContext?.().userId === owner;
    } catch {
      return false;
    }
  };
}

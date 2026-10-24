export type ProfileRefreshSource = 'sibling' | 'focus' | 'visible';

/** Only an opaque invalidation crosses tabs. Each recipient reads its own RLS profile. */
export function subscribeProfileInvalidation(
  project: string,
  refresh: (source: ProfileRefreshSource) => void
) {
  const key = `soty.auth.profile-change.v1:${new URL(project).origin}`;
  const storage = (event: StorageEvent) => {
    try {
      if (event.storageArea === localStorage && event.key === key && event.newValue)
        refresh('sibling');
    } catch {
      /* Restricted storage still has the focus/visibility fallback. */
    }
  };
  const focus = () => refresh('focus');
  const visible = () => {
    if (document.visibilityState === 'visible') refresh('visible');
  };
  window.addEventListener('storage', storage);
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', visible);
  return {
    publish() {
      try {
        localStorage.setItem(key, crypto.randomUUID());
      } catch {
        /* Saving a profile does not depend on browser storage. */
      }
    },
    dispose() {
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
    }
  };
}

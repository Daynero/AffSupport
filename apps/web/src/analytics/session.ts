const SESSION_KEY = 'wishly.analytics.session.v1';
export const PRODUCT_SESSION_IDLE_MS = 30 * 60 * 1000;

type StoredSession = { id: string; lastActivity: number };

function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id
      ) &&
      typeof parsed.lastActivity === 'number'
    ) {
      return { id: parsed.id, lastActivity: parsed.lastActivity };
    }
  } catch {
    // Corrupt browser state is replaced with a fresh, anonymous session id.
  }
  return null;
}

export function productSessionId(now = Date.now(), storage: Storage = sessionStorage) {
  const saved = parseStoredSession(storage.getItem(SESSION_KEY));
  const id =
    saved && now - saved.lastActivity <= PRODUCT_SESSION_IDLE_MS ? saved.id : crypto.randomUUID();
  storage.setItem(SESSION_KEY, JSON.stringify({ id, lastActivity: now }));
  return id;
}

export function clearProductSession(storage: Storage = sessionStorage) {
  storage.removeItem(SESSION_KEY);
}

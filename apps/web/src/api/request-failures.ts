/** Shared by API calls and browser-loaded resources; no DOM or stored token is read here. */
export type RequestFailureKind = 'unauthorized' | 'forbidden' | 'connection_failed';
const listeners = new Set<(kind: RequestFailureKind) => void>();

export function onRequestFailure(listener: (kind: RequestFailureKind) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportRequestFailure(kind: RequestFailureKind) {
  for (const listener of [...listeners]) {
    try {
      listener(kind);
    } catch {
      /* Diagnostics must not replace the request's own result. */
    }
  }
}

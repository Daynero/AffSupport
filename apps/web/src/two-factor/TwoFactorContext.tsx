/**
 * The notebook's entries, held for the page (feature 016).
 *
 * A context rather than page-local state because three things read the same
 * list — the rows, the search filter and the form that adds to it — and because
 * the seeds have to be in memory before a button is pressed, not fetched when it
 * is. A browser will not let a clipboard write happen after an intervening
 * promise; the code has to be computed and copied inside the click. So the list
 * arrives once, whole, and the row does arithmetic rather than I/O.
 *
 * Written the way every other store in this app is: a context that throws
 * outside its provider, and an override so a test can render against a list
 * without a database.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  twoFactorApi,
  TwoFactorApiError,
  type TwoFactorApi,
  type TwoFactorEntry,
  type TwoFactorErrorCode
} from '../api/two-factor';

export type TwoFactorStatus = 'loading' | 'ready' | 'failed';

export interface TwoFactorStore {
  entries: TwoFactorEntry[];
  status: TwoFactorStatus;
  /** Why the last load failed, as a code the caller turns into copy. */
  errorCode: TwoFactorErrorCode | null;
  reload: () => Promise<void>;
  /**
   * Stores a new key. Resolves to `null` when it stuck, or to the code that
   * refused it — the form shows the message, so a rejection is a return value
   * here rather than a throw the caller has to remember to catch.
   */
  add: (name: string, seed: string) => Promise<TwoFactorErrorCode | null>;
  /** `seed: null` renames without touching what is stored. */
  edit: (id: string, name: string, seed: string | null) => Promise<TwoFactorErrorCode | null>;
  remove: (id: string) => Promise<TwoFactorErrorCode | null>;
}

const TwoFactorContext = createContext<TwoFactorStore | null>(null);

/** Lets a test render the page against a fixed notebook. */
export const TwoFactorContextOverride = TwoFactorContext.Provider;

export function useTwoFactor(): TwoFactorStore {
  const value = useContext(TwoFactorContext);
  if (!value) throw new Error('useTwoFactor must be used inside TwoFactorProvider');
  return value;
}

/** Narrows an unknown rejection to the code the interface can speak about. */
export function errorCodeOf(error: unknown): TwoFactorErrorCode {
  return error instanceof TwoFactorApiError ? error.code : 'UNKNOWN';
}

export function TwoFactorProvider({
  children,
  client = twoFactorApi
}: {
  children: ReactNode;
  /** Injectable so a test can drive the store without a network. */
  client?: TwoFactorApi;
}) {
  const [entries, setEntries] = useState<TwoFactorEntry[]>([]);
  const [status, setStatus] = useState<TwoFactorStatus>('loading');
  const [errorCode, setErrorCode] = useState<TwoFactorErrorCode | null>(null);

  const reload = useCallback(async () => {
    setStatus('loading');
    setErrorCode(null);
    try {
      setEntries(await client.listEntries());
      setStatus('ready');
    } catch (error) {
      setEntries([]);
      setErrorCode(errorCodeOf(error));
      setStatus('failed');
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(
    async (name: string, seed: string) => {
      try {
        const created = await client.createEntry(name, seed);
        // Prepended rather than refetched: the function returns the row it made,
        // and the list is ordered newest first, so this is the same answer the
        // server would give — without a second round trip carrying every seed.
        setEntries(current => [created, ...current]);
        return null;
      } catch (error) {
        return errorCodeOf(error);
      }
    },
    [client]
  );

  const edit = useCallback(
    async (id: string, name: string, seed: string | null) => {
      try {
        const updated = await client.updateEntry(id, name, seed);
        // Replaced where it stands. `created_at` is what orders the list and an
        // edit does not touch it, so a renamed entry must not jump — a row that
        // moves under the pointer is a row that gets mis-clicked.
        setEntries(current => current.map(item => (item.id === id ? updated : item)));
        return null;
      } catch (error) {
        return errorCodeOf(error);
      }
    },
    [client]
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await client.deleteEntry(id);
        setEntries(current => current.filter(item => item.id !== id));
        return null;
      } catch (error) {
        return errorCodeOf(error);
      }
    },
    [client]
  );

  const store = useMemo<TwoFactorStore>(
    () => ({ entries, status, errorCode, reload, add, edit, remove }),
    [entries, status, errorCode, reload, add, edit, remove]
  );

  return <TwoFactorContext.Provider value={store}>{children}</TwoFactorContext.Provider>;
}

/**
 * The 2FA notebook's four calls into Supabase (feature 016).
 *
 * There is no agent here and no HTTP client: the notebook is a browser tool, and
 * every path to a stored seed is a `security definer` function that derives the
 * owner from `auth.uid()`. This module is the whole client half of that
 * contract — see `specs/016-totp-notebook/contracts/rpc.md`.
 *
 * Shaped after `api/team.ts`: check `error` first, then map each row through a
 * total guard that returns `null` on anything unexpected, and reject the whole
 * batch rather than let one malformed row through as a half-built entry.
 */

import { requireSupabaseClient } from '../lib/supabase';

/** Stable machine codes, never a database sentence shown to a person. */
export type TwoFactorErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'INVALID_NAME'
  | 'INVALID_SECRET'
  | 'ENTRY_NOT_FOUND'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

const KNOWN_CODES: readonly TwoFactorErrorCode[] = [
  'NOT_AUTHENTICATED',
  'INVALID_NAME',
  'INVALID_SECRET',
  'ENTRY_NOT_FOUND',
  'INVALID_RESPONSE',
  'UNKNOWN'
];

export class TwoFactorApiError extends Error {
  readonly code: TwoFactorErrorCode;

  constructor(code: TwoFactorErrorCode) {
    super(code);
    this.name = 'TwoFactorApiError';
    this.code = code;
  }
}

/**
 * One stored credential.
 *
 * `seed` is the decrypted value from the vault. It is the owner's own, and it
 * has to be here: the row's copy button hands it over, and codes are computed
 * from it inside the click that copies them.
 */
export interface TwoFactorEntry {
  id: string;
  name: string;
  seed: string;
  createdAt: string;
  updatedAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A row from any of the three returning functions, or `null` if it is not one.
 *
 * The rename lives here and only here: the column is `secret`, the field is
 * `seed`.
 */
function mapEntry(row: unknown): TwoFactorEntry | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  if (!isNonEmptyString(record.id)) return null;
  if (typeof record.name !== 'string') return null;
  if (!isNonEmptyString(record.secret)) return null;
  if (!isNonEmptyString(record.created_at)) return null;
  if (!isNonEmptyString(record.updated_at)) return null;
  return {
    id: record.id,
    name: record.name,
    seed: record.secret,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

/**
 * Turns a Supabase error into one of our codes.
 *
 * The functions raise bare codes, and PostgREST surfaces them as the error
 * message. Anything we do not recognise becomes `UNKNOWN` rather than reaching a
 * person as a raw database string — which could name a schema, a column, or the
 * shape of a query.
 */
function throwRpc(error: { message: string; code?: string } | null): never | void {
  if (!error) return;
  const haystack = `${error.message} ${error.code ?? ''}`;
  const match = KNOWN_CODES.find(code => haystack.includes(code));
  throw new TwoFactorApiError(match ?? 'UNKNOWN');
}

/** The rows of a function that returns a set, mapped or rejected as a batch. */
function mapEntries(data: unknown): TwoFactorEntry[] {
  if (!Array.isArray(data)) throw new TwoFactorApiError('INVALID_RESPONSE');
  const entries = data.map(mapEntry);
  if (entries.some(entry => entry === null)) throw new TwoFactorApiError('INVALID_RESPONSE');
  return entries.filter((entry): entry is TwoFactorEntry => entry !== null);
}

/** The single row a create or update returns. */
function mapOnly(data: unknown): TwoFactorEntry {
  const [entry] = mapEntries(data);
  if (!entry) throw new TwoFactorApiError('INVALID_RESPONSE');
  return entry;
}

export const twoFactorApi = {
  /** The caller's whole notebook, newest first, seeds included. */
  async listEntries(): Promise<TwoFactorEntry[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_two_factor_entries');
    throwRpc(error);
    return mapEntries(data ?? []);
  },

  async createEntry(name: string, seed: string): Promise<TwoFactorEntry> {
    const { data, error } = await requireSupabaseClient().rpc('create_two_factor_entry', {
      p_name: name,
      p_secret: seed
    });
    throwRpc(error);
    return mapOnly(data ?? []);
  },

  /** `seed: null` renames without touching what is stored. */
  async updateEntry(id: string, name: string, seed: string | null): Promise<TwoFactorEntry> {
    const { data, error } = await requireSupabaseClient().rpc('update_two_factor_entry', {
      p_entry: id,
      p_name: name,
      p_secret: seed
    });
    throwRpc(error);
    return mapOnly(data ?? []);
  },

  async deleteEntry(id: string): Promise<void> {
    const { error } = await requireSupabaseClient().rpc('delete_two_factor_entry', {
      p_entry: id
    });
    throwRpc(error);
  }
};

export type TwoFactorApi = typeof twoFactorApi;

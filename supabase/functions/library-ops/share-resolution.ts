import { TeamFunctionError } from '../_shared/errors.ts';
import type { TeamErrorCode } from '../../../packages/shared/dist/team/transport.js';

import { trustedMaterialUrl } from '../../../packages/shared/dist/team/creative-library.js';

type ShareAttribution = 'unchanged' | 'acknowledged' | 'unknown';
export interface ShareReservation {
  intentId: string;
  writeAllowed: boolean;
  state: 'write_started' | 'acknowledged' | 'confirmed' | 'blocked';
  attribution: ShareAttribution;
  shareVersion: string | null;
}
export interface MaterialLinkResult {
  state: 'ready' | 'confirmation_required';
  linkProtocol: 2;
  shareVersion: string | null;
  url: string;
  public: boolean | null;
  canShare: boolean;
  permissionChanged: boolean | null;
  sharing: 'unchanged' | 'confirmed' | 'uncertain';
  serverNow: string;
  visibilityCode?: TeamErrorCode;
  pendingCommandId?: string;
  preferenceSaved?: boolean;
  preferenceCode?: TeamErrorCode;
}
export interface ShareResolutionInput {
  fileId: string;
  webViewLink: unknown;
  canShare: boolean;
  shareVersion: string | null;
  allowIfRestricted: boolean;
  rememberChoice: boolean;
}
export interface ShareResolutionDependencies {
  listAnyonePermissions(fileId: string): Promise<Array<{ id: string; role: string }>>;
  /** Revalidate current actor, membership, material identity and ancestry. */
  authorizeWrite(): Promise<void>;
  /** Atomic immutable intent + per-provider-file hold; one permit ever per key. */
  reserve(publicObserved: boolean): Promise<ShareReservation>;
  observePublic(fileId: string): Promise<void>;
  pending(
    fileId: string
  ): Promise<{ pending: boolean; shareVersion: string | null; commandId?: string }>;
  createReader(fileId: string): Promise<{ id: string }>;
  /** Called before final verification; failure never permits another create. */
  recordAcknowledgement(intentId: string, permissionId: string): Promise<void>;
  /** Includes any acknowledgement in the same transaction as observed completion. */
  confirmPublic(intentId: string, permissionId: string | null, noWrite: boolean): Promise<void>;
  remember(): Promise<void>;
  now(): string;
}
const isPublic = (rows: Array<{ role: string }>) =>
  rows.some(row => ['reader', 'commenter', 'writer'].includes(row.role));
const codeOf = (cause: unknown): TeamErrorCode =>
  cause instanceof TeamFunctionError ? cause.code : 'DRIVE_UNAVAILABLE';

/** Resolving a URL and changing permission are independently observable outcomes. */
export async function resolveMaterialShare(
  input: ShareResolutionInput,
  deps: ShareResolutionDependencies
): Promise<MaterialLinkResult> {
  const url = trustedMaterialUrl(input.webViewLink);
  if (!url) throw new TeamFunctionError('CATALOG_LINK_UNAVAILABLE');
  const base = {
    url,
    serverNow: deps.now(),
    linkProtocol: 2 as const,
    shareVersion: input.shareVersion
  };
  let publicObserved: boolean;
  try {
    publicObserved = isPublic(await deps.listAnyonePermissions(input.fileId));
  } catch (cause) {
    // A verified provider URL remains usable even if visibility cannot be read.
    // A mutation never treats this failure as proof of a restricted file.
    return {
      ...base,
      state: 'ready',
      public: null,
      canShare: false,
      permissionChanged: input.allowIfRestricted ? null : false,
      sharing: input.allowIfRestricted ? 'uncertain' : 'unchanged',
      visibilityCode: codeOf(cause)
    };
  }
  if (!input.allowIfRestricted) {
    if (!publicObserved) {
      try {
        const status = await deps.pending(input.fileId);
        base.shareVersion = status.shareVersion;
        if (status.pending)
          return {
            ...base,
            state: 'ready',
            public: false,
            canShare: false,
            permissionChanged: null,
            sharing: 'uncertain',
            visibilityCode: 'CATALOG_LINK_SHARING_UNCERTAIN',
            ...(status.commandId ? { pendingCommandId: status.commandId } : {})
          };
      } catch (cause) {
        return {
          ...base,
          state: 'ready',
          public: false,
          canShare: false,
          permissionChanged: false,
          sharing: 'uncertain',
          visibilityCode: codeOf(cause)
        };
      }
    }
    if (publicObserved) {
      // This records an observation only; never changes a Drive permission. A
      // receipt outage must not hide a separately verified URL from the user.
      try {
        await deps.observePublic(input.fileId);
      } catch (cause) {
        return {
          ...base,
          state: 'ready',
          public: true,
          canShare: input.canShare,
          permissionChanged: false,
          sharing: 'uncertain',
          visibilityCode: codeOf(cause)
        };
      }
    }
    return {
      ...base,
      state: publicObserved ? 'ready' : 'confirmation_required',
      public: publicObserved,
      canShare: input.canShare,
      permissionChanged: false,
      sharing: 'unchanged'
    };
  }
  if (!publicObserved && !input.canShare) {
    return {
      ...base,
      state: 'confirmation_required',
      public: false,
      canShare: false,
      permissionChanged: false,
      sharing: 'unchanged'
    };
  }
  // Reading an already-public URL does not require edit permission. The service
  // reservation still verifies current view access and immutable actor binding.
  if (!publicObserved) await deps.authorizeWrite();
  const reservation = await deps.reserve(publicObserved);
  base.shareVersion = reservation.shareVersion;
  if (!publicObserved && reservation.state === 'confirmed') {
    // The old request is already settled. Current access may have been changed
    // outside Soty; another grant requires a fresh explicit confirmation/key.
    return {
      ...base,
      state: 'confirmation_required',
      public: false,
      canShare: input.canShare,
      permissionChanged: false,
      sharing: 'unchanged'
    };
  }
  let permissionId: string | null = null;
  let changed: boolean | null =
    reservation.attribution === 'acknowledged'
      ? true
      : reservation.attribution === 'unknown'
        ? null
        : false;
  let pending = false;
  let pendingCode: TeamErrorCode = 'CATALOG_LINK_SHARING_UNCERTAIN';
  let dispatched = false;
  if (!publicObserved && reservation.writeAllowed) {
    try {
      // The permit fences Soty requests; one final provider read also preserves
      // public access granted since the first inspection.
      publicObserved = isPublic(await deps.listAnyonePermissions(input.fileId));
      if (!publicObserved) {
        await deps.authorizeWrite();
        dispatched = true;
        const permission = await deps.createReader(input.fileId);
        permissionId = permission.id;
        changed = true;
        // If the reply to this SQL write is lost, confirmation below can still
        // retain the acknowledged provider ID. Never call create a second time.
        await deps.recordAcknowledgement(reservation.intentId, permissionId);
      }
    } catch (cause) {
      pending = true;
      pendingCode = codeOf(cause);
      if (permissionId === null) changed = null;
    }
  } else if (!publicObserved) {
    pending = true;
  }
  if (!publicObserved) {
    try {
      publicObserved = isPublic(await deps.listAnyonePermissions(input.fileId));
    } catch (cause) {
      return {
        ...base,
        state: 'ready',
        public: null,
        canShare: false,
        permissionChanged: changed,
        sharing: 'uncertain',
        visibilityCode: codeOf(cause)
      };
    }
  }
  if (!publicObserved) {
    return {
      ...base,
      state: 'ready',
      public: false,
      canShare: false,
      permissionChanged: changed,
      sharing: 'uncertain',
      visibilityCode: pendingCode
    };
  }
  try {
    await deps.confirmPublic(
      reservation.intentId,
      permissionId,
      reservation.writeAllowed && !dispatched
    );
    pending = false;
  } catch {
    pending = true;
  }
  let result: MaterialLinkResult = {
    ...base,
    state: 'ready',
    public: true,
    canShare: input.canShare,
    permissionChanged: changed,
    sharing: pending ? 'uncertain' : changed === false ? 'unchanged' : 'confirmed',
    ...(pending ? { visibilityCode: 'CATALOG_LINK_SHARING_UNCERTAIN' as const } : {})
  };
  if (input.rememberChoice && !pending) {
    try {
      await deps.remember();
      result = { ...result, preferenceSaved: true };
    } catch (cause) {
      result = { ...result, preferenceSaved: false, preferenceCode: codeOf(cause) };
    }
  }
  return result;
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
export function parseShareReservation(value: unknown): ShareReservation {
  if (!value || typeof value !== 'object') throw new TeamFunctionError('INVALID_RESPONSE');
  const row = value as Record<string, unknown>;
  if (
    !uuid(row.intentId) ||
    typeof row.writeAllowed !== 'boolean' ||
    (row.shareVersion !== null && !uuid(row.shareVersion)) ||
    typeof row.state !== 'string' ||
    !['write_started', 'acknowledged', 'confirmed', 'blocked'].includes(row.state) ||
    typeof row.attribution !== 'string' ||
    !['unchanged', 'acknowledged', 'unknown'].includes(row.attribution) ||
    (row.writeAllowed && (row.state !== 'write_started' || row.attribution !== 'unchanged'))
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    intentId: row.intentId,
    writeAllowed: row.writeAllowed,
    state: row.state as ShareReservation['state'],
    attribution: row.attribution as ShareReservation['attribution'],
    shareVersion: row.shareVersion as string | null
  };
}
export function parseShareStatus(value: unknown): {
  pending: boolean;
  shareVersion: string | null;
  commandId?: string;
} {
  if (!value || typeof value !== 'object') throw new TeamFunctionError('INVALID_RESPONSE');
  const row = value as Record<string, unknown>;
  if (
    typeof row.pending !== 'boolean' ||
    (row.shareVersion !== null && !uuid(row.shareVersion)) ||
    (row.commandId !== null && row.commandId !== undefined && !uuid(row.commandId)) ||
    (!row.pending && row.commandId !== null && row.commandId !== undefined)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    pending: row.pending,
    shareVersion: row.shareVersion as string | null,
    ...(typeof row.commandId === 'string' ? { commandId: row.commandId } : {})
  };
}

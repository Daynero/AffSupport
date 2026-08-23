import { evaluateDriveOAuthGate, type OAuthProductionSignals } from '../_shared/auth.ts';
import type { DriveFileMetadata } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export interface RootCandidateSnapshot {
  id: string;
  name: string;
  driveId: string | null;
  driveKind: 'my_drive' | 'shared_drive';
  resourceKey: string | null;
  capabilities: DriveFileMetadata['capabilities'];
}

export function validateRootCandidate(metadata: DriveFileMetadata): RootCandidateSnapshot {
  if (metadata.trashed) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  if (metadata.shortcutTargetId || metadata.mimeType === 'application/vnd.google-apps.shortcut') {
    throw new TeamFunctionError('UNSUPPORTED_MEDIA', { retryable: false });
  }
  if (metadata.mimeType !== 'application/vnd.google-apps.folder') {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  if (!metadata.capabilities.canListChildren) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  return {
    id: metadata.id,
    name: metadata.name,
    driveId: metadata.driveId,
    driveKind: metadata.driveId ? 'shared_drive' : 'my_drive',
    resourceKey: metadata.resourceKey,
    capabilities: metadata.capabilities
  };
}

export type DriveConnectCommand =
  // 'start' and 'reauth' are two members carrying one shape rather than one member with a
  // union discriminant. They are otherwise identical, and writing them as
  // `action: 'start' | 'reauth'` reads better — but TypeScript will not eliminate such a
  // member when the discriminant is negated, so `if (action === 'start' || action ===
  // 'reauth') return` left both alive for the rest of the function and every later
  // property access on the narrowed command was unchecked.
  | { action: 'start'; teamId: string; reuseCredentialId?: string }
  | { action: 'reauth'; teamId: string; reuseCredentialId?: string }
  | {
      action: 'confirm';
      teamId: string;
      folderId: string;
      resourceKey?: string;
      expectedAccount?: string;
      confirmed: boolean;
    }
  | {
      action: 'detach';
      teamId: string;
      confirmed: boolean;
      idempotencyKey: string;
      connectionId?: string;
    }
  | {
      action: 'replace';
      teamId: string;
      folderId: string;
      resourceKey?: string;
      expectedAccount?: string;
      confirmed: boolean;
      idempotencyKey: string;
    };

export interface DriveConnectDependencies {
  oauthMode: unknown;
  signals: OAuthProductionSignals;
  createOAuthTransaction?: (input: DriveConnectCommand) => Promise<unknown>;
  exchangeCode?: (input: unknown) => Promise<unknown>;
  writeCredential?: (input: unknown) => Promise<unknown>;
  loadAccount?: () => Promise<{ email: string }>;
  getRoot?: (folderId: string, resourceKey?: string | null) => Promise<DriveFileMetadata>;
  persistConnection?: (input: RootCandidateSnapshot & { teamId: string }) => Promise<{
    connectionId: string;
  }>;
  enqueueInitialSync?: (input: {
    teamId: string;
    connectionId: string;
    rootFolderId: string;
  }) => Promise<{ jobId: string }>;
  mutateConnection?: (input: DriveConnectCommand) => Promise<unknown>;
  deleteDriveFile?: (id: string) => Promise<unknown>;
}

function requireGate(dependencies: DriveConnectDependencies): void {
  const gate = evaluateDriveOAuthGate(dependencies.oauthMode, dependencies.signals);
  if (!gate.allowed) {
    throw new TeamFunctionError('OAUTH_APPROVAL_REQUIRED', {
      status: 503,
      retryable: false
    });
  }
}

export async function executeDriveConnectCommand(
  command: DriveConnectCommand,
  dependencies: DriveConnectDependencies
): Promise<unknown> {
  requireGate(dependencies);

  if (command.action === 'start' || command.action === 'reauth') {
    if (!dependencies.createOAuthTransaction) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    return dependencies.createOAuthTransaction(command);
  }

  if (command.action === 'confirm') {
    if (!dependencies.loadAccount || !dependencies.getRoot) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    const [account, metadata] = await Promise.all([
      dependencies.loadAccount(),
      dependencies.getRoot(command.folderId, command.resourceKey)
    ]);
    if (command.confirmed && !command.expectedAccount) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    if (
      command.expectedAccount &&
      account.email.trim().toLocaleLowerCase('en-US') !==
        command.expectedAccount.trim().toLocaleLowerCase('en-US')
    ) {
      throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
    }
    const root = validateRootCandidate(metadata);
    if (!command.confirmed) {
      return {
        state: 'confirmation_required',
        folder: root,
        account: account.email,
        independentAclWarning: true
      };
    }
    if (!dependencies.persistConnection || !dependencies.enqueueInitialSync) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
    const persisted = await dependencies.persistConnection({ ...root, teamId: command.teamId });
    const queued = await dependencies.enqueueInitialSync({
      teamId: command.teamId,
      connectionId: persisted.connectionId,
      rootFolderId: root.id
    });
    return {
      connectionId: persisted.connectionId,
      syncJobId: queued.jobId,
      state: 'connected',
      syncState: 'queued',
      folder: root
    };
  }

  if (!command.confirmed || command.idempotencyKey.length < 8) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  if (!dependencies.mutateConnection) {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  return dependencies.mutateConnection(command);
}

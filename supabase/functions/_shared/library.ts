import type {
  CreativeLibraryContribution,
  LibraryPlacement
} from '../../../packages/shared/dist/team/creative-library.js';
import { TeamFunctionError } from './errors.ts';
import type { ServiceRpcClient } from './credentials.ts';
import {
  type DriveFileMetadata,
  GoogleDriveClient,
  proveLiveAncestry,
  requireDriveCapability
} from './drive.ts';
import { isRecord } from './validation.ts';

const PROVIDER_ID = /^[^\u0000-\u001f]{1,1024}$/u;

export type LibraryFolderSegment = 'stage' | 'offer' | 'language' | 'type';

export interface CanonicalFolderBinding {
  materialId: string;
  segment: LibraryFolderSegment;
  value: string;
  parentFolderId: string;
  driveFolderId: string;
  resourceKey: string | null;
}

export interface LibraryGroupMember {
  materialId: string;
  driveFileId: string;
  resourceKey: string | null;
  parentFolderId: string | null;
  role: 'source' | 'transcript' | 'translation';
}

export interface LibraryGroupIntent {
  intentId: string;
  teamId: string;
  operationId: string;
  sourceMaterialId: string;
  action: 'move' | 'trash' | 'restore';
  members: LibraryGroupMember[];
  appliedMemberIds: string[];
}

export function normalizeCanonicalSegment(value: unknown, maximum = 120): string {
  if (typeof value !== 'string') throw new TeamFunctionError('INVALID_INPUT');
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    normalized === '.' ||
    normalized === '..' ||
    /[\u0000-\u001f/\\]/u.test(normalized)
  ) {
    throw new TeamFunctionError('INVALID_INPUT');
  }
  return normalized;
}

export function canonicalPlacementSegments(
  placement: LibraryPlacement
): ReadonlyArray<{ segment: LibraryFolderSegment; value: string }> {
  return [
    { segment: 'stage', value: normalizeCanonicalSegment(placement.stage, 32) },
    { segment: 'offer', value: normalizeCanonicalSegment(placement.offer) },
    { segment: 'language', value: normalizeCanonicalSegment(placement.language, 35) },
    { segment: 'type', value: normalizeCanonicalSegment(placement.type, 64) }
  ];
}

function parseFolderBinding(value: unknown): CanonicalFolderBinding | null {
  if (
    !isRecord(value) ||
    typeof value.material_id !== 'string' ||
    !['stage', 'offer', 'language', 'type'].includes(String(value.segment)) ||
    typeof value.value !== 'string' ||
    typeof value.parent_folder_id !== 'string' ||
    typeof value.drive_folder_id !== 'string' ||
    (value.resource_key !== null && typeof value.resource_key !== 'string')
  ) {
    return null;
  }
  return {
    materialId: value.material_id,
    segment: value.segment as LibraryFolderSegment,
    value: value.value,
    parentFolderId: value.parent_folder_id,
    driveFolderId: value.drive_folder_id,
    resourceKey: value.resource_key
  };
}

/**
 * Ensures exactly one folder at each structural depth. Database locks/uniqueness arbitrate
 * concurrent creators; provider listings are always rechecked before a folder is created.
 */
export async function ensureCanonicalFolderPath(input: {
  service: ServiceRpcClient;
  drive: GoogleDriveClient;
  teamId: string;
  connectionId: string;
  rootFolderId: string;
  placement: LibraryPlacement;
}): Promise<CanonicalFolderBinding[]> {
  let parentFolderId = input.rootFolderId;
  const output: CanonicalFolderBinding[] = [];
  for (const part of canonicalPlacementSegments(input.placement)) {
    const { data: reserved, error: reserveError } = await input.service.rpc(
      'service_reserve_library_folder',
      {
        p_team: input.teamId,
        p_connection: input.connectionId,
        p_parent_folder_id: parentFolderId,
        p_segment: part.segment,
        p_value: part.value
      }
    );
    if (reserveError) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    const binding = parseFolderBinding(Array.isArray(reserved) ? reserved[0] : reserved);
    if (binding) {
      const live = await input.drive.getFile(binding.driveFolderId, binding.resourceKey);
      if (
        !live.trashed &&
        live.mimeType === 'application/vnd.google-apps.folder' &&
        live.parents.includes(parentFolderId)
      ) {
        output.push(binding);
        parentFolderId = binding.driveFolderId;
        continue;
      }
    }

    const page = await input.drive.listFolders({ parentId: parentFolderId });
    const existing = page.files.find(
      folder =>
        folder.name.normalize('NFC').toLocaleLowerCase('en-US') ===
        part.value.toLocaleLowerCase('en-US')
    );
    const folder =
      existing ?? (await input.drive.createFolder({ name: part.value, parentId: parentFolderId }));
    const { data: committed, error: commitError } = await input.service.rpc(
      'service_commit_library_folder',
      {
        p_team: input.teamId,
        p_connection: input.connectionId,
        p_parent_folder_id: parentFolderId,
        p_segment: part.segment,
        p_value: part.value,
        p_drive_folder_id: folder.id,
        p_resource_key: folder.resourceKey
      }
    );
    if (commitError) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    const committedBinding = parseFolderBinding(
      Array.isArray(committed) ? committed[0] : committed
    );
    if (!committedBinding) throw new TeamFunctionError('INVALID_RESPONSE');
    output.push(committedBinding);
    parentFolderId = committedBinding.driveFolderId;
  }
  return output;
}

function parseGroupMember(value: unknown): LibraryGroupMember | null {
  if (
    !isRecord(value) ||
    typeof value.material_id !== 'string' ||
    typeof value.drive_file_id !== 'string' ||
    !PROVIDER_ID.test(value.drive_file_id) ||
    (value.resource_key !== null && typeof value.resource_key !== 'string') ||
    (value.parent_folder_id !== null && typeof value.parent_folder_id !== 'string') ||
    !['source', 'transcript', 'translation'].includes(String(value.role))
  ) {
    return null;
  }
  return {
    materialId: value.material_id,
    driveFileId: value.drive_file_id,
    resourceKey: value.resource_key,
    parentFolderId: value.parent_folder_id,
    role: value.role as LibraryGroupMember['role']
  };
}

export function parseLibraryGroupIntent(value: unknown): LibraryGroupIntent | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (
    !isRecord(row) ||
    typeof row.intent_id !== 'string' ||
    typeof row.team_id !== 'string' ||
    typeof row.operation_id !== 'string' ||
    typeof row.source_material_id !== 'string' ||
    !['move', 'trash', 'restore'].includes(String(row.action)) ||
    !Array.isArray(row.members) ||
    row.members.length < 1 ||
    row.members.length > 100
  ) {
    return null;
  }
  const members = row.members.map(parseGroupMember);
  const appliedMemberIds = Array.isArray(row.applied_member_ids)
    ? row.applied_member_ids.filter((value): value is string => typeof value === 'string')
    : [];
  if (
    members.some(member => member === null) ||
    appliedMemberIds.length !==
      (Array.isArray(row.applied_member_ids) ? row.applied_member_ids.length : 0)
  ) {
    return null;
  }
  return {
    intentId: row.intent_id,
    teamId: row.team_id,
    operationId: row.operation_id,
    sourceMaterialId: row.source_material_id,
    action: row.action as LibraryGroupIntent['action'],
    members: members.filter((member): member is LibraryGroupMember => member !== null),
    appliedMemberIds
  };
}

export function assertCurrentSourceVersion(
  live: Pick<DriveFileMetadata, 'version' | 'checksum'>,
  expectedVersion: string
): void {
  if ((live.version ?? live.checksum) !== expectedVersion) {
    throw new TeamFunctionError('SOURCE_CHANGED');
  }
}

/**
 * Mutates a snapshotted source/sidecar group in order. Completed members are reported to the
 * saga after each provider write. A partial failure is explicitly reconciling, never success.
 */
export async function applyLibraryGroupMutation(input: {
  service: ServiceRpcClient;
  drive: GoogleDriveClient;
  rootFolderId: string;
  intent: LibraryGroupIntent;
  destinationFolderId?: string | null;
  sourceName?: string | null;
}): Promise<void> {
  if (input.intent.action === 'move' && !input.destinationFolderId) {
    throw new TeamFunctionError('INVALID_INPUT');
  }
  const destination = input.destinationFolderId
    ? await proveLiveAncestry({
        client: input.drive,
        fileId: input.destinationFolderId,
        rootFolderId: input.rootFolderId
      })
    : null;
  if (destination) requireDriveCapability(destination, 'canAddChildren');

  try {
    const alreadyApplied = new Set(input.intent.appliedMemberIds);
    for (const member of input.intent.members) {
      if (alreadyApplied.has(member.materialId)) continue;
      const live = await proveLiveAncestry({
        client: input.drive,
        fileId: member.driveFileId,
        resourceKey: member.resourceKey,
        rootFolderId: input.rootFolderId,
        allowTrashedTarget: input.intent.action === 'restore'
      });
      if (input.intent.action === 'move') {
        requireDriveCapability(live, 'canMoveItemWithinDrive');
        await input.drive.updateFileMetadata({
          fileId: live.id,
          resourceKey: member.resourceKey,
          ...(member.role === 'source' && input.sourceName ? { name: input.sourceName } : {}),
          addParentId: input.destinationFolderId!,
          removeParentIds: live.parents
        });
      } else if (input.intent.action === 'trash') {
        requireDriveCapability(live, 'canTrash');
        await input.drive.updateFileMetadata({
          fileId: live.id,
          resourceKey: member.resourceKey,
          trashed: true
        });
      } else {
        requireDriveCapability(live, 'canUntrash');
        await input.drive.updateFileMetadata({
          fileId: live.id,
          resourceKey: member.resourceKey,
          trashed: false,
          ...(input.destinationFolderId
            ? { addParentId: input.destinationFolderId, removeParentIds: live.parents }
            : {})
        });
      }
      const { error } = await input.service.rpc('service_checkpoint_material_group_intent', {
        p_intent: input.intent.intentId,
        p_material: member.materialId
      });
      if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    }
  } catch (error) {
    await input.service.rpc('service_mark_material_group_reconciling', {
      p_intent: input.intent.intentId,
      p_error_code: safeProviderErrorCode(error)
    });
    throw new TeamFunctionError('GROUP_RECONCILING', { retryable: true });
  }
}

export function safeProviderErrorCode(error: unknown): string {
  if (error instanceof TeamFunctionError) return error.code;
  return 'DRIVE_UNAVAILABLE';
}

export async function recordLibraryContribution(input: {
  service: ServiceRpcClient;
  teamId: string;
  actorId: string;
  contribution: CreativeLibraryContribution;
}): Promise<void> {
  const { error } = await input.service.rpc('service_append_library_contribution', {
    p_team: input.teamId,
    p_actor: input.actorId,
    p_category: input.contribution.category,
    p_action: input.contribution.action,
    p_outcome: input.contribution.outcome,
    p_agent_instance: input.contribution.agentInstanceId ?? null
  });
  if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
}

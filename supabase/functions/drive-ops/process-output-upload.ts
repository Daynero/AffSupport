import type { GoogleDriveClient, DriveFileMetadata } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { PROCESS_OUTPUT_NONCE_KEY } from './process-output-recovery.ts';

type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export function requireProcessUploadProducer(body: Record<string, unknown>): string {
  if (
    body.outputUploadProtocolVersion !== 2 ||
    typeof body.checksum !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(body.checksum)
  ) {
    throw new TeamFunctionError('AGENT_UPDATE_REQUIRED', { retryable: false });
  }
  return body.checksum;
}

export async function startOwnedProcessUpload(input: {
  rpc: Rpc;
  client: Pick<GoogleDriveClient, 'generateFileId' | 'startResumableUpload'>;
  operationId: string;
  actorId: string;
  teamId: string;
  connectionId: string;
  rootId: string;
  parentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}) {
  const candidate = await input.client.generateFileId();
  const binding = await input.rpc('service_prepare_process_upload', {
    p_operation: input.operationId,
    p_actor: input.actorId,
    p_connection: input.connectionId,
    p_file: candidate,
    p_checksum: input.checksum
  });
  if (
    !isRecord(binding) ||
    binding.operationId !== input.operationId ||
    binding.teamId !== input.teamId ||
    binding.connectionId !== input.connectionId ||
    binding.rootId !== input.rootId ||
    binding.parentId !== input.parentId ||
    binding.name !== input.name ||
    binding.mimeType !== input.mimeType ||
    binding.sizeBytes !== input.sizeBytes ||
    binding.checksum !== input.checksum ||
    typeof binding.fileId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(binding.fileId) ||
    typeof binding.nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(binding.nonce)
  ) {
    throw new TeamFunctionError('INVALID_RESPONSE');
  }
  // A started binding can mean a lost session reply. Do not open another session
  // or allocate a replacement identity; durable cleanup reconciles the old one.
  if (binding.state !== 'prepared') throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  if (
    (await input.rpc('service_start_process_upload', {
      p_operation: input.operationId,
      p_actor: input.actorId
    })) !== true
  ) {
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  }
  const session = await input.client.startResumableUpload({
    newFileId: binding.fileId,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    parentId: input.parentId,
    appProperties: { [PROCESS_OUTPUT_NONCE_KEY]: binding.nonce }
  });
  return { ...session, providerFileId: binding.fileId };
}

/** Legacy unbound operations retain their old path; never fabricate ownership. */
export function verifyOwnedProcessUploadResult(
  binding: unknown,
  result: Pick<
    DriveFileMetadata,
    'id' | 'name' | 'mimeType' | 'size' | 'checksum' | 'parents' | 'appProperties' | 'trashed'
  >,
  operationId: string
): void {
  if (binding === null) return;
  if (
    !isRecord(binding) ||
    binding.operationId !== operationId ||
    binding.state !== 'started' ||
    binding.fileId !== result.id ||
    binding.name !== result.name ||
    binding.mimeType !== result.mimeType ||
    binding.sizeBytes !== result.size ||
    binding.checksum !== result.checksum ||
    typeof binding.parentId !== 'string' ||
    result.parents.length !== 1 ||
    result.parents[0] !== binding.parentId ||
    typeof binding.nonce !== 'string' ||
    result.appProperties[PROCESS_OUTPUT_NONCE_KEY] !== binding.nonce ||
    result.trashed
  ) {
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  }
}

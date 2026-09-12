import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const KEYS = new Set([
  'schemaVersion',
  'runId',
  'repository',
  'sourceSha',
  'version',
  'bump',
  'notes',
  'targetId',
  'targetKind',
  'platforms',
  'resourceProfile',
  'createdAt',
  'deadlineAt',
  'backendPlanDigest'
]);
const SHA = /^[a-f0-9]{40,64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class IntentError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INTENT_INVALID';
  }
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntentError(`${field} must be an object`);
  return value;
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new IntentError(`${field} must be an ISO timestamp`);
  return value;
}

/** Parses an untrusted intent into a frozen, deterministic data boundary. */
export function resolveIntent(value) {
  const input = object(value, 'intent');
  for (const key of Object.keys(input)) if (!KEYS.has(key)) throw new IntentError(`Unknown intent field: ${key}`);
  if (input.schemaVersion !== 1) throw new IntentError('Unsupported intent schemaVersion');
  if (typeof input.runId !== 'string' || !UUID.test(input.runId)) throw new IntentError('runId must be a UUIDv4');
  if (typeof input.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(input.repository)) throw new IntentError('repository must be owner/name');
  if (typeof input.sourceSha !== 'string' || !SHA.test(input.sourceSha)) throw new IntentError('sourceSha must be a full hexadecimal git object ID');
  const hasVersion = typeof input.version === 'string';
  const hasBump = typeof input.bump === 'string';
  if (hasVersion === hasBump) throw new IntentError('Exactly one of version or bump is required');
  if (hasVersion && !VERSION.test(input.version)) throw new IntentError('version is invalid');
  if (hasBump && !['patch', 'minor', 'major'].includes(input.bump)) throw new IntentError('bump is invalid');
  const notes = object(input.notes, 'notes');
  const noteKeys = Object.keys(notes);
  if (noteKeys.length !== 1 || !['digest', 'commitRange'].includes(noteKeys[0])) throw new IntentError('notes must contain exactly digest or commitRange');
  if ('digest' in notes && (typeof notes.digest !== 'string' || !DIGEST.test(notes.digest))) throw new IntentError('notes.digest must be SHA-256');
  if ('commitRange' in notes && (typeof notes.commitRange !== 'string' || !/^[a-f0-9]{7,64}\.\.[a-f0-9]{7,64}$/u.test(notes.commitRange))) throw new IntentError('notes.commitRange is invalid');
  if (typeof input.targetId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(input.targetId)) throw new IntentError('targetId is invalid');
  if (input.targetKind !== 'production' && input.targetKind !== 'sandbox') throw new IntentError('targetKind is invalid');
  if (!Array.isArray(input.platforms) || input.platforms.length === 0 || new Set(input.platforms).size !== input.platforms.length || !input.platforms.every(platform => platform === 'macos-arm64' || platform === 'windows-x64')) throw new IntentError('platforms is invalid');
  const resourceProfile = object(input.resourceProfile, 'resourceProfile');
  if (Object.values(resourceProfile).some(entry => !['string', 'number', 'boolean'].includes(typeof entry))) throw new IntentError('resourceProfile contains an invalid value');
  iso(input.createdAt, 'createdAt');
  if (input.deadlineAt !== undefined) iso(input.deadlineAt, 'deadlineAt');
  if (input.backendPlanDigest !== undefined && (typeof input.backendPlanDigest !== 'string' || !DIGEST.test(input.backendPlanDigest))) throw new IntentError('backendPlanDigest must be SHA-256');
  const resolved = {
    schemaVersion: 1,
    runId: input.runId,
    repository: input.repository,
    sourceSha: input.sourceSha,
    ...(hasVersion ? { version: input.version } : { bump: input.bump }),
    notes: 'digest' in notes ? { digest: notes.digest } : { commitRange: notes.commitRange },
    targetId: input.targetId,
    targetKind: input.targetKind,
    platforms: [...input.platforms],
    resourceProfile: { ...resourceProfile },
    createdAt: input.createdAt,
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    ...(input.backendPlanDigest ? { backendPlanDigest: input.backendPlanDigest } : {})
  };
  return Object.freeze(resolved);
}

export function intentDigest(intent) {
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

export async function readIntent(intentPath) {
  let raw;
  try {
    raw = JSON.parse(await readFile(intentPath, 'utf8'));
  } catch (error) {
    throw new IntentError(`Cannot read intent: ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolveIntent(raw);
}

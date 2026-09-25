import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  LOCAL_MANIFEST_BOUNDS,
  NATIVE_DIRECTORY_READ_MAX_BYTES,
  isNativeDirectoryIntakeResult,
  isLocalManifestRelativePath,
  type NativeDirectoryIntakeEntry,
  type NativeDirectoryIntakeResult
} from '@video-compressor/shared';
import type { FastifyInstance } from 'fastify';
import { hasCapability } from '../server/capabilities.js';
import { failureCode } from '../server/failure-codes.js';
import { selectDirectoryIntakeFolder } from './picker.js';
import { pathGrants, type PathGrantLedger } from './path-grants.js';

const INTAKE_TTL_MS = 30 * 60_000;

interface IntakeGrant {
  root: string;
  rootDev: number;
  rootIno: number;
  expiresAt: number;
  files: Map<string, { dev: number; ino: number; size: number }>;
}

/** One agent-owned, ephemeral scope per native selection; never a cloud path. */
export class DirectoryIntake {
  #grants = new Map<string, IntakeGrant>();
  #busy = false;
  #closed = false;

  constructor(
    private readonly pick: () => Promise<string | null> = selectDirectoryIntakeFolder,
    private readonly ledger: PathGrantLedger = pathGrants,
    private readonly now: () => number = () => Date.now()
  ) {}

  async select(): Promise<NativeDirectoryIntakeResult> {
    if (this.#closed) throw new Error('DIRECTORY_INTAKE_UNAVAILABLE');
    if (this.#busy) throw new Error('DIRECTORY_INTAKE_BUSY');
    this.#busy = true;
    try {
      return await this.#select();
    } finally {
      this.#busy = false;
    }
  }

  busy(): boolean {
    return this.#busy;
  }

  async #select(): Promise<NativeDirectoryIntakeResult> {
    this.#expire();
    const selected = await this.pick();
    if (this.#closed) throw new Error('DIRECTORY_INTAKE_UNAVAILABLE');
    if (selected === null) return { kind: 'canceled' };
    const grant = this.ledger.mint(selected, { access: 'read', origin: 'picker' });
    if (!grant || grant.kind !== 'dir') throw new Error('PATH_NOT_GRANTED');
    try {
      const rootName = path.basename(grant.path);
      if (!isLocalManifestRelativePath(rootName)) throw new Error('INVALID_INPUT');
      const entries: NativeDirectoryIntakeEntry[] = [{ kind: 'directory', relativePath: rootName }];
      const files = new Map<string, { dev: number; ino: number; size: number }>();
      const pending = [{ absolute: grant.path, relative: rootName, depth: 0 }];
      let directories = 1;
      let totalBytes = 0;
      while (pending.length > 0) {
        const current = pending.pop();
        if (!current) break;
        const currentInfo = await lstat(current.absolute);
        const currentReal = await realpath(current.absolute);
        if (
          this.#closed ||
          !currentInfo.isDirectory() ||
          (current.absolute !== grant.path &&
            !currentReal.startsWith(`${grant.path}${path.sep}`)) ||
          (current.absolute === grant.path &&
            (currentInfo.dev !== grant.dev || currentInfo.ino !== grant.ino))
        )
          throw new Error('PATH_NOT_GRANTED');
        for (const child of await readdir(current.absolute, { withFileTypes: true })) {
          const absolute = path.join(current.absolute, child.name);
          const relative = `${current.relative}/${child.name}`;
          if (!isLocalManifestRelativePath(relative)) throw new Error('INVALID_INPUT');
          const info = await lstat(absolute);
          if (info.isSymbolicLink()) throw new Error('FILE_UNAVAILABLE');
          if (info.isDirectory()) {
            if (
              ++directories > LOCAL_MANIFEST_BOUNDS.directories ||
              current.depth + 1 > LOCAL_MANIFEST_BOUNDS.depth
            )
              throw new Error('FILE_TOO_LARGE');
            entries.push({ kind: 'directory', relativePath: relative });
            pending.push({ absolute, relative, depth: current.depth + 1 });
          } else if (info.isFile()) {
            totalBytes += info.size;
            if (
              files.size >= LOCAL_MANIFEST_BOUNDS.files ||
              info.size > LOCAL_MANIFEST_BOUNDS.fileBytes ||
              totalBytes > LOCAL_MANIFEST_BOUNDS.totalBytes
            )
              throw new Error('FILE_TOO_LARGE');
            entries.push({
              kind: 'file',
              relativePath: relative,
              sizeBytes: info.size,
              mimeType: 'application/octet-stream'
            });
            files.set(relative, { dev: info.dev, ino: info.ino, size: info.size });
          } else {
            throw new Error('FILE_UNAVAILABLE');
          }
        }
      }
      const result: NativeDirectoryIntakeResult = {
        kind: 'selected',
        grantId: grant.id,
        rootName,
        entries
      };
      if (!isNativeDirectoryIntakeResult(result) || this.#closed) throw new Error('INVALID_INPUT');
      this.#grants.set(grant.id, {
        root: grant.path,
        rootDev: grant.dev,
        rootIno: grant.ino,
        expiresAt: this.now() + INTAKE_TTL_MS,
        files
      });
      return result;
    } catch (error) {
      this.ledger.revoke(grant.id);
      throw error;
    }
  }

  async read(input: unknown): Promise<Buffer> {
    if (this.#closed) throw new Error('DIRECTORY_INTAKE_UNAVAILABLE');
    this.#expire();
    if (!isReadRequest(input)) throw new Error('INVALID_INPUT');
    const scope = this.#grants.get(input.grantId);
    const grant = this.ledger.get(input.grantId);
    if (!scope || !grant || grant.path !== scope.root || grant.kind !== 'dir')
      throw new Error('PATH_NOT_GRANTED');
    const expected = scope.files.get(input.relativePath);
    if (!expected || input.offset >= expected.size) throw new Error('FILE_UNAVAILABLE');
    const rootInfo = await lstat(scope.root);
    if (!rootInfo.isDirectory() || rootInfo.dev !== scope.rootDev || rootInfo.ino !== scope.rootIno)
      throw new Error('PATH_NOT_GRANTED');
    const segments = input.relativePath.split('/');
    if (segments[0] !== path.basename(scope.root)) throw new Error('PATH_NOT_GRANTED');
    let absolute = scope.root;
    for (const segment of segments.slice(1)) {
      absolute = path.join(absolute, segment);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('PATH_NOT_GRANTED');
    }
    const resolved = await realpath(absolute);
    if (!resolved.startsWith(`${scope.root}${path.sep}`)) throw new Error('PATH_NOT_GRANTED');
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.dev !== expected.dev ||
        info.ino !== expected.ino ||
        info.size !== expected.size ||
        (await realpath(absolute)) !== resolved
      )
        throw new Error('FILE_UNAVAILABLE');
      const length = Math.min(input.length, info.size - input.offset);
      const result = Buffer.alloc(length);
      const { bytesRead } = await handle.read(result, 0, length, input.offset);
      return result.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  shutdown(): void {
    this.#closed = true;
    for (const id of this.#grants.keys()) this.ledger.revoke(id);
    this.#grants.clear();
  }

  #expire(): void {
    for (const [id, grant] of this.#grants) {
      if (grant.expiresAt <= this.now() || !this.ledger.get(id)) {
        this.#grants.delete(id);
        this.ledger.revoke(id);
      }
    }
  }
}

function isReadRequest(value: unknown): value is {
  grantId: string;
  relativePath: string;
  offset: number;
  length: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(key =>
      ['grantId', 'relativePath', 'offset', 'length'].includes(key)
    ) &&
    typeof record.grantId === 'string' &&
    isLocalManifestRelativePath(record.relativePath) &&
    typeof record.offset === 'number' &&
    Number.isSafeInteger(record.offset) &&
    record.offset >= 0 &&
    typeof record.length === 'number' &&
    Number.isSafeInteger(record.length) &&
    record.length > 0 &&
    record.length <= NATIVE_DIRECTORY_READ_MAX_BYTES
  );
}

export function registerDirectoryIntakeRoutes(app: FastifyInstance, intake: DirectoryIntake): void {
  app.post('/api/team/directory-intake/select', async (_request, reply) => {
    if (!hasCapability('directory-intake'))
      return reply.code(501).send({ error: 'DIRECTORY_INTAKE_UNAVAILABLE' });
    try {
      return await intake.select();
    } catch (error) {
      return reply.code(400).send({ error: failureCode(error) });
    }
  });
  app.post('/api/team/directory-intake/read', async (request, reply) => {
    if (!hasCapability('directory-intake'))
      return reply.code(501).send({ error: 'DIRECTORY_INTAKE_UNAVAILABLE' });
    try {
      const chunk = await intake.read(request.body);
      return reply.type('application/octet-stream').send(chunk);
    } catch (error) {
      return reply.code(400).send({ error: failureCode(error) });
    }
  });
}

import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbValueDigest } from '../scripts/lib/mini-db-transaction.mjs';
import {
  miniDbConnectionString,
  readMiniDbDocument,
  validateMiniDbDraft
} from '../scripts/lib/mini-db-plan.mjs';
import { verifyMiniDbBackendProof } from '../scripts/lib/mini-db-release.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});
const binding = {
  kind: 'production',
  bindingId: 'production',
  supabaseProject: 'a'.repeat(20),
  digest: 'b'.repeat(64)
};
function draft() {
  const sql = 'ALTER TABLE public.widgets ADD COLUMN note text;';
  const migration = {
    path: 'supabase/migrations/20261025120000_optional_note.sql',
    version: '20261025120000',
    name: 'optional_note',
    sql,
    sourceDigest: createHash('sha256').update(sql).digest('hex')
  };
  const content = {
    schemaVersion: 1,
    kind: 'mini-db-draft',
    sourceSha: 'a'.repeat(40),
    agentSha: 'b'.repeat(40),
    bindingDigest: binding.digest,
    targetId: binding.bindingId,
    projectRef: binding.supabaseProject,
    backendPaths: [migration.path],
    inventory: [migration],
    migrations: [migration],
    before: { history: [] }
  };
  return { ...content, draftDigest: dbValueDigest(content) };
}
function rehash(value: ReturnType<typeof draft>) {
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'draftDigest')
  );
  return { ...value, draftDigest: dbValueDigest(content) };
}

describe('DB mini plan and publication boundary', () => {
  it('requires a dedicated release credential and never adopts analytics credentials', () => {
    expect(() => miniDbConnectionString({ ANALYTICS_DATABASE_URL: 'private' })).toThrow(
      'DB_RELEASE_CREDENTIAL_MISSING'
    );
    expect(miniDbConnectionString({ SOTY_MINI_DATABASE_URL: 'release-only' })).toBe('release-only');
  });
  it('binds pending SQL to exact source bytes, target and suffix', () => {
    const good = draft();
    expect(validateMiniDbDraft(good, binding)).toBe(good);
    expect(() => validateMiniDbDraft(good, { ...binding, digest: 'c'.repeat(64) })).toThrow(
      'DB_BINDING_MISMATCH'
    );
    const changed = structuredClone(good);
    changed.inventory[0].sql = 'DELETE FROM public.widgets;';
    expect(() => validateMiniDbDraft(rehash(changed), binding)).toThrow(
      'DB_INVENTORY_CONTENT_MISMATCH'
    );
    const omitted = structuredClone(good);
    omitted.migrations = [];
    expect(() => validateMiniDbDraft(rehash(omitted), binding)).toThrow('DB_PENDING_MISMATCH');
  });
  it('rejects data-changing SQL even if the draft has been consistently rehashed', () => {
    const value = draft();
    value.inventory[0].sql = 'DELETE FROM public.widgets;';
    value.inventory[0].sourceDigest = createHash('sha256')
      .update(value.inventory[0].sql)
      .digest('hex');
    expect(() => validateMiniDbDraft(rehash(value), binding)).toThrow(
      'DB_MINI_SQL_NOT_EXPAND_ONLY'
    );
  });
  it('refuses a prepared-only proof before any file access or network operation', async () => {
    await expect(
      verifyMiniDbBackendProof({
        cwd: '/missing-mini-db-proof',
        binding,
        sourceSha: 'a'.repeat(40),
        backend: {
          schemaVersion: 1,
          kind: 'mini-db',
          state: 'prepared',
          sourceSha: 'a'.repeat(40),
          planDigest: 'b'.repeat(64),
          rehearsalDigest: 'c'.repeat(64),
          betaSchemaVerified: true
        }
      })
    ).rejects.toThrow('DB_WEB_PROOF_UNPROVEN');
  });
  it('refuses symlinked private evidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mini-db-doc-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'real.json'), '{}');
    await symlink(path.join(directory, 'real.json'), path.join(directory, 'link.json'));
    await expect(readMiniDbDocument(path.join(directory, 'link.json'))).rejects.toThrow(
      'DB_PLAN_FILE_UNSAFE'
    );
  });
});

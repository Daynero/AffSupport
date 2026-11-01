import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acceptedWorkspaceCutover } from '../scripts/lib/release/workspace-cutover.mjs';

const approval = JSON.parse(readFileSync('config/workspace-cutover.json', 'utf8'));
const migration = 'supabase/migrations/20261207093000_accounts_destructive_delete.sql';
const change = {
  kind: 'migration',
  targetId: 'production',
  id: approval.migrationId,
  digest: approval.digest,
  compatibilityAcceptance: approval.id
};
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'soty-workspace-cutover-'));
  for (const dir of ['config', 'packages/shared/src', 'supabase/migrations']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, 'config/workspace-cutover.json'), JSON.stringify(approval));
  writeFileSync(
    path.join(root, 'packages/shared/src/release.ts'),
    "export const PRODUCT_VERSION = '1.3.0';"
  );
  writeFileSync(path.join(root, migration), readFileSync(migration));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('accepts only the owner-approved exact Workspace migration', () => {
  expect(acceptedWorkspaceCutover(change, root)).toBe(true);
});
it.each([
  { targetId: 'other' },
  { kind: 'function' },
  { id: '20261207110000' },
  { digest: '0'.repeat(64) },
  { compatibilityAcceptance: undefined }
])('refuses changed plan identity %j', patch => {
  expect(acceptedWorkspaceCutover({ ...change, ...patch }, root)).toBe(false);
});
it('revokes acceptance after SQL drift even if the old reviewed digest stays in the plan', () => {
  writeFileSync(path.join(root, migration), readFileSync(migration, 'utf8') + '\nselect 1;');
  expect(acceptedWorkspaceCutover(change, root)).toBe(false);
});
it('cannot be reused by a later release', () => {
  writeFileSync(
    path.join(root, 'packages/shared/src/release.ts'),
    "export const PRODUCT_VERSION = '1.3.1';"
  );
  expect(acceptedWorkspaceCutover(change, root)).toBe(false);
});
it('refuses additional unaccepted findings and absent approval', () => {
  writeFileSync(
    path.join(root, 'config/workspace-cutover.json'),
    JSON.stringify({ ...approval, acceptedReasons: [] })
  );
  expect(acceptedWorkspaceCutover(change, root)).toBe(false);
  rmSync(path.join(root, 'config/workspace-cutover.json'));
  expect(acceptedWorkspaceCutover(change, root)).toBe(false);
});

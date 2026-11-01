import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clientBreakingStatements } from './migration-compat.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Exact owner-approved Workspace cutover, never a general compatibility switch.
 * Any SQL, release version, target or finding drift revokes the acceptance.
 * @param {{kind: string, targetId: string, id: string, digest: string, compatibilityAcceptance?: string}} change
 */
export function acceptedWorkspaceCutover(change, root = repositoryRoot) {
  try {
    const approval = JSON.parse(readFileSync(path.join(root, 'config/workspace-cutover.json'), 'utf8'));
    const release = readFileSync(path.join(root, 'packages/shared/src/release.ts'), 'utf8');
    const version = /PRODUCT_VERSION = '([^']+)'/u.exec(release)?.[1];
    if (approval.schemaVersion !== 1 || approval.id !== 'workspace-1.3.0' ||
        approval.version !== version || version !== '1.3.0' ||
        change.kind !== 'migration' || change.targetId !== approval.targetId ||
        change.id !== approval.migrationId || change.digest !== approval.digest ||
        change.compatibilityAcceptance !== approval.id || !approval.ownerDecision?.trim()) return false;
    const sql = readFileSync(path.join(root, 'supabase/migrations/20261207093000_accounts_destructive_delete.sql'), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== approval.digest) return false;
    const reasons = clientBreakingStatements(sql).map(item => item.reason).sort();
    return JSON.stringify(reasons) === JSON.stringify([...approval.acceptedReasons].sort());
  } catch {
    return false;
  }
}

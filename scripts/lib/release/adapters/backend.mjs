import { preparedReceipt, reconcileReceipt } from '../migration-evidence.mjs';

/**
 * Applying the declared backend plan, and nothing else.
 *
 * A release may change the server only in ways somebody wrote down in advance.
 * That is not bureaucracy: the database is the one effect here that cannot be
 * re-run, rolled back by guesswork, or re-published under a new version. So this
 * adapter refuses three things that all look like small conveniences —
 *
 *   - applying whatever happens to be pending (an extra migration that arrived
 *     from another branch is not part of this release),
 *   - applying a change whose content no longer matches the digest that was
 *     reviewed,
 *   - applying a change that the previous client cannot live with, which would
 *     break every user who has not updated yet.
 *
 * The receipt is written before the write, never after. A crash between the two
 * leaves a record saying "this was about to happen", which is exactly the
 * question reconciliation needs to answer; a receipt written afterwards would
 * leave the one state nobody can interpret.
 */

export class BackendError extends Error {
  constructor(code, subject) {
    super(subject ?? code);
    this.code = code;
  }
}

function assertTarget(binding, plan) {
  if (!binding?.bindingId) throw new BackendError('TARGET_MISMATCH', 'No validated target binding');
  for (const change of plan.changes) {
    if (change.targetId !== binding.bindingId)
      throw new BackendError('TARGET_MISMATCH', `Change ${change.id} targets ${change.targetId}`);
  }
}

/**
 * The pending set the server reports must be exactly the migrations this release
 * declared — same members, same order. An extra pending migration means somebody
 * else's work would ride along unreviewed; a missing one means the plan no
 * longer describes reality.
 */
export function assertExactPendingSet(plan, pending) {
  const planned = plan.changes.filter(change => change.kind === 'migration').map(change => change.id);
  const observed = [...pending];
  const extra = observed.filter(id => !planned.includes(id));
  const absent = planned.filter(id => !observed.includes(id));
  if (extra.length || absent.length)
    throw new BackendError(
      'BACKEND_PENDING_SET_MISMATCH',
      `pending set differs from plan (extra: ${extra.join(', ') || 'none'}; missing: ${absent.join(', ') || 'none'})`
    );
  if (planned.some((id, index) => observed[index] !== id))
    throw new BackendError('BACKEND_PENDING_SET_MISMATCH', 'pending migrations are not in planned order');
  return planned;
}

/**
 * @param {{
 *   binding: {bindingId: string},
 *   plan: {changes: readonly object[]},
 *   sourceSha: string,
 *   adapter: {
 *     pendingMigrations: () => Promise<string[]>,
 *     digestOf: (change: object) => Promise<string>,
 *     backwardsCompatible: (change: object) => Promise<boolean>,
 *     apply: (change: object) => Promise<{ok: boolean, transaction?: string, partial?: boolean}>,
 *     observe: (change: object) => Promise<{historyPresent: boolean, postconditionsPass: boolean, targetId: string, provenAbsent?: boolean}>
 *   },
 *   journal: {flush: (receipt: {state: string, targetId: string, version: string, digest: string}) => Promise<void>}
 * }} options
 */
export async function applyBackendPlan({ binding, plan, sourceSha, adapter, journal }) {
  if (!plan?.changes?.length) return Object.freeze({ ok: true, applied: [], writes: 0 });
  assertTarget(binding, plan);
  assertExactPendingSet(plan, await adapter.pendingMigrations());

  const applied = [];
  for (const change of plan.changes) {
    const digest = await adapter.digestOf(change);
    if (digest !== change.digest)
      throw new BackendError(
        'BACKEND_CONTENT_MISMATCH',
        `${change.id} content ${digest} does not match the reviewed ${change.digest}`
      );
    if (!(await adapter.backwardsCompatible(change)))
      throw new BackendError(
        'BACKEND_INCOMPATIBLE',
        `${change.id} is not compatible with the currently released client`
      );

    const receipt = preparedReceipt({
      targetId: change.targetId,
      version: change.id,
      digest: change.digest,
      sourceSha,
      transaction: change.transaction ?? 'transactional'
    });
    // Flushed before the write: a crash after this line is interpretable.
    await journal.flush(receipt);

    const result = await adapter.apply(change);
    const observation = await adapter.observe(change);
    const reconciled = reconcileReceipt({ ...receipt, transaction: result.transaction ?? receipt.transaction }, observation);
    if (!reconciled.ok) {
      // A half-applied nontransactional change is where invented rollbacks do
      // their damage. Stop and say so; a person decides what happens next.
      throw new BackendError(reconciled.code, `${change.id} could not be reconciled after apply`);
    }
    applied.push({ id: change.id, state: reconciled.state });
  }
  return Object.freeze({ ok: true, applied, writes: applied.length });
}

import { readFileSync } from 'node:fs';

export const STEP_IDS = /** @type {const} */ ([
  'preflight',
  'prepare',
  'candidate_gate',
  'beta_package',
  'beta_verify',
  // Declared server changes are rehearsed against the isolated beta project
  // before anything depends on them, and applied only after the artifacts are
  // published and proven — never in the other order, because a database that
  // has moved ahead of the clients that talk to it cannot be moved back.
  'backend_beta',
  'readiness',
  'macos_package',
  'windows_smoke',
  'publish',
  'manifest',
  'manifest_beta_verify',
  'backend_apply',
  'deploy',
  'live_verify'
]);

/**
 * Where a declared backend change runs, by the position its plan names.
 *
 * `backend-plan.mjs` accepts exactly these two positions; this is what makes
 * them mean something in the registry rather than being free-form labels.
 */
export const BACKEND_STEPS = Object.freeze({
  'before-readiness': 'backend_beta',
  'before-web': 'backend_apply'
});

/** The steps that exist only to carry a declared backend plan. */
export const BACKEND_STEP_IDS = /** @type {readonly string[]} */ (
  Object.freeze(Object.values(BACKEND_STEPS))
);

/**
 * Which steps are heavy boundaries, and of what kind.
 *
 * Every step that compiles, installs, archives, starts the beta stack, or moves
 * and hashes whole artifacts is named here, because a boundary that is missing
 * from this table is a boundary that runs without asking the machine whether it
 * can afford to. Only two steps are genuinely light: `preflight` reads local
 * state and asks remote services what they already know, and `backend_apply`
 * writes to a remote database — expensive to get wrong, cheap in local load.
 */
const RESOURCE_CLASS = Object.freeze({
  prepare: 'shared_compile',
  candidate_gate: 'serial_tests',
  beta_package: 'package_archive',
  beta_verify: 'hash_download',
  // The rehearsal drives the local beta stack, so it is a heavy boundary even
  // though the change it rehearses is remote.
  backend_beta: 'beta_stack',
  readiness: 'beta_stack',
  macos_package: 'package_archive',
  windows_smoke: 'hash_download',
  publish: 'hash_download',
  manifest: 'hash_download',
  manifest_beta_verify: 'hash_download',
  deploy: 'web_agent_native_build',
  live_verify: 'hash_download'
});

/**
 * Steps whose effect is visible outside this machine the moment it lands. They
 * are bounded and reconciled rather than killed, because a publish interrupted
 * halfway is worse than one that finishes. `backend_apply` belongs here for the
 * same reason even though it costs this machine almost nothing: killing it
 * mid-write is the one interruption that cannot be tidied up afterwards.
 */
const NON_INTERRUPTIBLE = new Set(['publish', 'manifest', 'backend_apply', 'deploy']);

const LIGHT_TIMEOUT_MS = 15 * 60_000;

const profiles = JSON.parse(
  readFileSync(new URL('../../../config/release-resource-profiles.json', import.meta.url), 'utf8')
);

/**
 * Timeouts come from the calibrated resource profile rather than a number
 * repeated here, so raising an estimate after a measured run changes both the
 * reservation and the deadline together.
 */
function timeoutFor(resourceClass) {
  if (resourceClass === 'light') return LIGHT_TIMEOUT_MS;
  const classProfile = profiles.default.classes[resourceClass];
  if (!classProfile) throw new Error(`Unknown release resource class: ${resourceClass}`);
  return classProfile.timeoutMs;
}

export const STEP_DEFINITIONS = Object.freeze(
  STEP_IDS.map((id, index) => {
    const resourceClass = RESOURCE_CLASS[id] ?? 'light';
    return Object.freeze({
      id,
      dependencies: index === 0 ? [] : [STEP_IDS[index - 1]],
      resourceClass,
      heavy: resourceClass !== 'light',
      timeoutMs: timeoutFor(resourceClass),
      interruption: NON_INTERRUPTIBLE.has(id) ? 'reconcile' : 'terminate',
      retry: NON_INTERRUPTIBLE.has(id) ? 'inspect-before-retry' : 'bounded'
    });
  })
);

export function stepDefinition(stepId) {
  const step = STEP_DEFINITIONS.find(candidate => candidate.id === stepId);
  if (!step) throw new Error(`Unknown release step: ${stepId}`);
  return step;
}

export function dependenciesSatisfied(stepId, completed) {
  return stepDefinition(stepId).dependencies.every(id => completed.has(id));
}

/** The heavy steps, in registry order; used to assert no boundary is unguarded. */
export function heavySteps() {
  return STEP_DEFINITIONS.filter(step => step.heavy).map(step => step.id);
}

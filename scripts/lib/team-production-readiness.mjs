import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, requiredNames } from './env-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Derived, not retyped.
 *
 * This list used to be eight names maintained by hand, and it was wrong in the
 * way hand-maintained lists are always wrong: it named the secrets the Drive
 * work happened to need on the day it was written. AGENT_TOKEN_PRIVATE_KEY was
 * not among them, so a production project missing it passed this gate and then
 * answered 503 to every attempt to pair the desktop app.
 *
 * It now asks config/environments.json which function secrets production
 * requires. Adding a required secret to the registry extends this gate on the
 * same commit, which is the only arrangement that stays true.
 */
export const REQUIRED_TEAM_PRODUCTION_SECRETS = Object.freeze(
  requiredNames(loadRegistry(root), 'functions', 'production')
);

export const REQUIRED_TEAM_MEMBER_PILOT_SECRETS = Object.freeze([
  'TEAM_DIRECT_ADD_MODE',
  'WISHLY_SITE_URL'
]);

export function parseSupabaseSecretNames(value) {
  if (!Array.isArray(value)) throw new Error('invalid Supabase secrets response');
  return value
    .filter(entry => entry && typeof entry === 'object' && typeof entry.name === 'string')
    .map(entry => entry.name);
}

export function missingTeamProductionSecrets(secretNames, options = {}) {
  const available = new Set(secretNames);
  const required = options.memberPilot
    ? REQUIRED_TEAM_MEMBER_PILOT_SECRETS
    : REQUIRED_TEAM_PRODUCTION_SECRETS;
  return required.filter(name => !available.has(name));
}

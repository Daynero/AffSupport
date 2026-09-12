#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSurface, loadRegistry, scanSurface, variablesFor } from './lib/env-registry.mjs';

/**
 * The code and the registry describe the same set of variables. Offline.
 *
 * This is the cheap half of configuration parity and it runs on every push,
 * because the expensive half — asking the live project what it actually has —
 * can only check names somebody remembered to write down. A variable that
 * enters the code and no document is invisible to every other gate in this
 * repository, and stays invisible until a user meets the 503.
 *
 * It deliberately refuses both directions. A name in the code that the registry
 * does not know is the outage. A name in the registry that the code no longer
 * reads is how the registry stops being believed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const registry = loadRegistry(root);

for (const [id, surface] of Object.entries(registry.surfaces)) {
  const used = scanSurface(root, surface);
  const registered = variablesFor(registry, id).map(variable => variable.name);
  const { unregistered, unused } = compareSurface({ registered, used });
  for (const name of unregistered)
    failures.push(
      `${id}: ${name} is read by the code but absent from config/environments.json — ` +
        `no gate knows whether production has it`
    );
  for (const name of unused)
    failures.push(`${id}: ${name} is declared in config/environments.json but no code reads it`);
}

/**
 * The browser surface has a second declaration — the ambient typing — and a
 * variable missing from it type-checks as `undefined` at every call site rather
 * than failing, which is the quietest way to read a value that was never set.
 */
const typings = readFileSync(path.join(root, 'apps/web/src/vite-env.d.ts'), 'utf8');
for (const variable of variablesFor(registry, 'web')) {
  if (!new RegExp(`\\breadonly ${variable.name}\\??:`, 'u').test(typings))
    failures.push(`web: ${variable.name} is missing from apps/web/src/vite-env.d.ts`);
}

/**
 * The entitlement pair. The private half signs in an Edge Function, the public
 * half ships inside the desktop app; if they ever stop being declared together,
 * the failure they cause is every paired user silently losing entitlement.
 */
const pair = ['AGENT_TOKEN_PRIVATE_KEY', 'AGENT_ENTITLEMENT_PUBLIC_KEY'];
const declaredPair = pair.filter(name => registry.variables.some(entry => entry.name === name));
if (declaredPair.length === 1)
  failures.push(
    `the entitlement key pair is half-declared: ${declaredPair[0]} without ${pair.find(name => name !== declaredPair[0])}`
  );

if (failures.length) {
  process.stderr.write(`Environment registry check failed:\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}

const counts = Object.keys(registry.surfaces)
  .map(id => `${id} ${variablesFor(registry, id).length}`)
  .join(', ');
process.stdout.write(`Environment registry matches the code (${counts}).\n`);

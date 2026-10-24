import { scanAcceptanceIsolation } from './lib/acceptance-isolation.mjs';

// Read-only, local source/artifact check. It never connects to a database or
// deploys anything. Missing bundle evidence is explicit in the JSON result.
const result = scanAcceptanceIsolation();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
